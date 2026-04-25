import { Router } from 'express';
import { rename, mkdir, copyFile, unlink, existsSync } from 'fs';
import { promisify } from 'util';
import { join, dirname } from 'path';
import db from '../db.js';

const router = Router();
const renameP = promisify(rename);
const mkdirP = promisify(mkdir);
const copyP = promisify(copyFile);
const unlinkP = promisify(unlink);

// Counts per favourite level — must be before /:id
router.get('/counts', (req, res) => {
  const { folder = '', search = '' } = req.query;
  const conditions = [];
  const params = [];
  if (folder) { conditions.push('folder_path = ?'); params.push(folder); }
  if (search) {
    conditions.push('(filename LIKE ? OR positive_prompt LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT favorite, COUNT(*) as n FROM images ${where} GROUP BY favorite ORDER BY favorite`
  ).all(...params);
  const counts = {};
  for (const row of rows) counts[row.favorite] = row.n;
  res.json(counts);
});

// List unique metadata keys — must be before /:id
router.get('/meta/keys', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT key FROM metadata ORDER BY key').all();
  res.json(rows.map(r => r.key));
});

// List images with filtering, sorting, pagination
router.get('/', (req, res) => {
  const {
    folder = '',
    sort = 'mtime-desc',
    favorite_min = 0,
    search = '',
    meta_key = '',
    meta_value = '',
    limit = 100,
    offset = 0,
  } = req.query;

  const params = [];
  const conditions = [];

  if (folder) {
    conditions.push('i.folder_path = ?');
    params.push(folder);
  }
  if (Number(favorite_min) > 0) {
    conditions.push('i.favorite >= ?');
    params.push(Number(favorite_min));
  }
  if (search) {
    conditions.push('(i.filename LIKE ? OR i.positive_prompt LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  let join = '';
  if (meta_key && meta_value) {
    join = 'JOIN metadata m ON m.image_id = i.id';
    conditions.push('m.key = ? AND m.value LIKE ?');
    params.push(meta_key, `%${meta_value}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortMap = {
    'mtime-desc': 'i.mtime DESC',
    'mtime-asc':  'i.mtime ASC',
    'name-asc':   'i.filename ASC',
    'name-desc':  'i.filename DESC',
    'fav-desc':   'i.favorite DESC, i.mtime DESC',
    'fav-asc':    'i.favorite ASC, i.mtime DESC',
  };
  const orderBy = sortMap[sort] || 'i.mtime DESC';

  const countRow = db.prepare(`SELECT COUNT(DISTINCT i.id) as n FROM images i ${join} ${where}`).get(...params);
  const total = countRow?.n || 0;

  const images = db.prepare(`
    SELECT DISTINCT i.id, i.path, i.filename, i.folder_path, i.size, i.mtime,
           i.width, i.height, i.format, i.favorite, i.file_hash,
           i.positive_prompt, i.negative_prompt
    FROM images i ${join} ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  res.json({ images, total });
});

// Get single image details
router.get('/:id', (req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).json({ error: 'not found' });
  res.json(img);
});

// Get all metadata for an image
router.get('/:id/metadata', (req, res) => {
  const img = db.prepare('SELECT id FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare('SELECT key, value FROM metadata WHERE image_id = ? ORDER BY key').all(req.params.id);
  res.json(rows);
});

// Update favorite level
router.patch('/:id', (req, res) => {
  const { favorite } = req.body;
  if (favorite === undefined) return res.status(400).json({ error: 'favorite required' });
  const level = Math.max(0, Math.min(5, Number(favorite)));
  db.prepare('UPDATE images SET favorite = ? WHERE id = ?').run(level, req.params.id);
  res.json({ ok: true });
});

// Move images to a folder
router.post('/move', async (req, res) => {
  const { ids, targetFolder } = req.body;
  if (!Array.isArray(ids) || !targetFolder) return res.status(400).json({ error: 'ids and targetFolder required' });

  try {
    await mkdirP(targetFolder, { recursive: true });
  } catch {}

  const errors = [];
  for (const id of ids) {
    const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!img) continue;
    const dest = join(targetFolder, img.filename);
    try {
      // If same filesystem, rename; otherwise copy+delete
      try {
        await renameP(img.path, dest);
      } catch (err) {
        if (err.code === 'EXDEV') {
          await copyP(img.path, dest);
          await unlinkP(img.path);
        } else throw err;
      }
      db.prepare('UPDATE images SET path = ?, folder_path = ? WHERE id = ?').run(dest, targetFolder, id);
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }

  // Ensure target folder is in DB
  db.prepare('INSERT OR IGNORE INTO folders (path, name, parent_path) VALUES (?, ?, ?)').run(
    targetFolder, targetFolder.split('/').pop(), dirname(targetFolder)
  );

  res.json({ ok: true, errors });
});

// Delete images
router.delete('/', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const errors = [];
  for (const id of ids) {
    const img = db.prepare('SELECT path FROM images WHERE id = ?').get(id);
    if (!img) continue;
    try {
      await unlinkP(img.path);
    } catch (err) {
      if (err.code !== 'ENOENT') { errors.push({ id, error: err.message }); continue; }
    }
    db.prepare('DELETE FROM images WHERE id = ?').run(id);
  }
  res.json({ ok: true, errors });
});

export default router;
