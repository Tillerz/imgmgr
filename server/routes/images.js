import { Router } from 'express';
import { rename, mkdir, copyFile, unlink, existsSync } from 'fs';
import { promisify } from 'util';
import { join, dirname } from 'path';
import db from '../db.js';
import { trashImages, restoreImages, purgeImages } from '../trash.js';
import { hammingDistance } from '../thumbnails.js';
import { captionImage } from '../caption.js';

const router = Router();

// Search fields that can be targeted with a `field:term` prefix. Unprefixed
// terms search the default set (filename + positive prompt). Captions are
// opt-in via `caption:` so they never dilute ordinary prompt searches.
const SEARCH_FIELDS = { caption: 'caption', prompt: 'positive_prompt', name: 'filename', file: 'filename' };

// Parse a search string into include/exclude terms.
//   space = AND (all include terms must match)
//   -term = exclude       "quoted phrase" = literal phrase (may span spaces)
//   field:term / field:"phrase" restricts a term to one field (see SEARCH_FIELDS)
// The '-'/'+' operator may be attached (-blurry) or spaced (- blurry / - "low
// quality"); a spaced operator applies to the next term. It only acts as an
// operator at a term boundary, so words like "close-up" stay intact.
// Each returned term is { term, field } where field is a SEARCH_FIELDS key or null.
export function parseSearchTerms(search) {
  const tokens = search.match(/[+-]?(?:[A-Za-z]+:)?"[^"]*"|\S+/g) || [];
  const include = [];
  const exclude = [];
  let pendingNeg = false; // a standalone -/+ applies to the following term
  for (let tok of tokens) {
    if (tok === '-') { pendingNeg = true; continue; }
    if (tok === '+') { pendingNeg = false; continue; }
    let neg = pendingNeg;
    pendingNeg = false;
    if (tok[0] === '-') { neg = true; tok = tok.slice(1); }
    else if (tok[0] === '+') { tok = tok.slice(1); }
    // Optional field prefix, e.g. caption:sunset or caption:"golden hour". Only
    // recognised field names are treated as a prefix; anything else (steps:30) is
    // kept literal so existing searches don't change meaning.
    let field = null;
    const fm = tok.match(/^([A-Za-z]+):([\s\S]*)$/);
    if (fm && SEARCH_FIELDS[fm[1].toLowerCase()]) { field = fm[1].toLowerCase(); tok = fm[2]; }
    if (tok[0] === '"' && tok[tok.length - 1] === '"') tok = tok.slice(1, -1);
    tok = tok.trim();
    if (!tok) continue;
    (neg ? exclude : include).push({ term: tok, field });
  }
  return { include, exclude };
}

// Escape LIKE wildcards so underscores/percents in prompts match literally.
const likeEscape = s => s.replace(/[\\%_]/g, c => '\\' + c);

// Build a WHERE fragment matching the parsed terms. A term with no field prefix
// matches filename OR positive_prompt (unchanged default); a `field:` term
// matches just that column. `col` is the column prefix ('' or 'i.').
export function buildSearchClause(search, col = '') {
  const { include, exclude } = parseSearchTerms(search);
  // Columns a term applies to, given its field (null = default set).
  const colsFor = (field) => {
    if (field) return [`COALESCE(${col}${SEARCH_FIELDS[field]}, '')`];
    return [`${col}filename`, `COALESCE(${col}positive_prompt, '')`];
  };
  const clauses = [];
  const params = [];
  for (const { term, field } of include) {
    const exprs = colsFor(field);
    clauses.push('(' + exprs.map(e => `${e} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    for (let i = 0; i < exprs.length; i++) params.push(`%${likeEscape(term)}%`);
  }
  for (const { term, field } of exclude) {
    const exprs = colsFor(field);
    clauses.push('(' + exprs.map(e => `${e} NOT LIKE ? ESCAPE '\\'`).join(' AND ') + ')');
    for (let i = 0; i < exprs.length; i++) params.push(`%${likeEscape(term)}%`);
  }
  return { clause: clauses.join(' AND '), params };
}

const renameP = promisify(rename);
const mkdirP = promisify(mkdir);
const copyP = promisify(copyFile);
const unlinkP = promisify(unlink);

// Counts per favourite level — must be before /:id
router.get('/counts', (req, res) => {
  const { folder = '', search = '' } = req.query;
  const conditions = ['i.trashed_at IS NULL'];
  const joins = [];
  const params = [];
  if (folder) { conditions.push('i.folder_path = ?'); params.push(folder); }
  if (search) {
    const s = buildSearchClause(search, 'i.');
    if (s.clause) { conditions.push(s.clause); params.push(...s.params); }
  }
  applyFacets(req, joins, conditions, params);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT i.favorite AS favorite, COUNT(*) as n FROM images i ${joins.join(' ')} ${where} GROUP BY i.favorite ORDER BY i.favorite`
  ).all(...params);
  const counts = {};
  for (const row of rows) counts[row.favorite] = row.n;
  res.json(counts);
});

// All IDs matching current filters — used by select-all to cover unloaded pages
router.get('/ids', (req, res) => {
  const { folder = '', favorite_min = 0, search = '', tag = '' } = req.query;
  const params = [];
  const conditions = ['i.trashed_at IS NULL'];
  const joins = [];

  if (folder) { conditions.push('i.folder_path = ?'); params.push(folder); }
  if (Number(favorite_min) > 0) { conditions.push('i.favorite >= ?'); params.push(Number(favorite_min)); }
  if (search) {
    const s = buildSearchClause(search, 'i.');
    if (s.clause) { conditions.push(s.clause); params.push(...s.params); }
  }
  if (tag) { joins.push('JOIN tags tg ON tg.image_id = i.id'); conditions.push('tg.tag = ?'); params.push(tag); }
  applyFacets(req, joins, conditions, params);

  const join = joins.join(' ');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT DISTINCT i.id FROM images i ${join} ${where} ORDER BY i.mtime DESC`).all(...params);
  res.json(rows.map(r => r.id));
});

// List unique metadata keys — must be before /:id
router.get('/meta/keys', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT key FROM metadata ORDER BY key').all();
  res.json(rows.map(r => r.key));
});

// Distinct values (with counts) for a metadata key — powers the facet dropdowns.
router.get('/meta/values', (req, res) => {
  const { key } = req.query;
  if (!key) return res.json([]);
  const rows = db.prepare(`
    SELECT m.value AS value, COUNT(*) AS n
    FROM metadata m JOIN images i ON i.id = m.image_id
    WHERE m.key = ? AND i.trashed_at IS NULL AND m.value <> ''
    GROUP BY m.value
    ORDER BY n DESC, value ASC
    LIMIT 500
  `).all(String(key));
  res.json(rows);
});

// Parse the `facets` query param (JSON: {key: value}) into JOIN/WHERE fragments
// matching images that have a metadata row with that exact key/value.
function applyFacets(req, joins, conditions, params) {
  let facets = {};
  try { facets = req.query.facets ? JSON.parse(req.query.facets) : {}; } catch { facets = {}; }
  let i = 0;
  for (const [key, value] of Object.entries(facets)) {
    if (value == null || value === '') continue;
    const a = `mf${i++}`;
    joins.push(`JOIN metadata ${a} ON ${a}.image_id = i.id`);
    conditions.push(`${a}.key = ? AND ${a}.value = ?`);
    params.push(String(key), String(value));
  }
}

// List images with filtering, sorting, pagination
router.get('/', (req, res) => {
  const {
    folder = '',
    sort = 'mtime-desc',
    favorite_min = 0,
    search = '',
    meta_key = '',
    meta_value = '',
    tag = '',
    trashed = '',
    limit = 100,
    offset = 0,
  } = req.query;

  const isTrash = String(trashed) === '1';
  const params = [];
  const conditions = [];
  const joins = [];

  conditions.push(isTrash ? 'i.trashed_at IS NOT NULL' : 'i.trashed_at IS NULL');
  if (folder && !isTrash) {
    conditions.push('i.folder_path = ?');
    params.push(folder);
  }
  if (Number(favorite_min) > 0) {
    conditions.push('i.favorite >= ?');
    params.push(Number(favorite_min));
  }
  if (search) {
    const s = buildSearchClause(search, 'i.');
    if (s.clause) { conditions.push(s.clause); params.push(...s.params); }
  }
  if (meta_key && meta_value) {
    joins.push('JOIN metadata m ON m.image_id = i.id');
    conditions.push('m.key = ? AND m.value LIKE ?');
    params.push(meta_key, `%${meta_value}%`);
  }
  if (tag) {
    joins.push('JOIN tags tg ON tg.image_id = i.id');
    conditions.push('tg.tag = ?');
    params.push(tag);
  }
  applyFacets(req, joins, conditions, params);

  const join = joins.join(' ');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortMap = {
    'mtime-desc': 'i.mtime DESC',
    'mtime-asc':  'i.mtime ASC',
    'name-asc':   'i.filename ASC',
    'name-desc':  'i.filename DESC',
    'fav-desc':   'i.favorite DESC, i.mtime DESC',
    'fav-asc':    'i.favorite ASC, i.mtime DESC',
  };
  const orderBy = isTrash ? 'i.trashed_at DESC' : (sortMap[sort] || 'i.mtime DESC');

  const countRow = db.prepare(`SELECT COUNT(DISTINCT i.id) as n FROM images i ${join} ${where}`).get(...params);
  const total = countRow?.n || 0;

  const images = db.prepare(`
    SELECT DISTINCT i.id, i.path, i.filename, i.folder_path, i.size, i.mtime,
           i.width, i.height, i.format, i.favorite, i.file_hash,
           i.positive_prompt, i.negative_prompt, i.trashed_at
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

// Generate (and store) an image caption via the SDNext VQA endpoint. Slow —
// the request stays open for the duration of the VLM inference.
router.post('/:id/caption', async (req, res) => {
  const img = db.prepare('SELECT id, path FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).json({ error: 'not found' });
  try {
    const caption = await captionImage(img.path, req.body || {});
    db.prepare('UPDATE images SET caption = ? WHERE id = ?').run(caption, img.id);
    res.json({ ok: true, id: img.id, caption });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Tags for an image
router.get('/:id/tags', (req, res) => {
  const rows = db.prepare('SELECT tag FROM tags WHERE image_id = ? ORDER BY tag').all(req.params.id);
  res.json(rows.map(r => r.tag));
});

router.post('/:id/tags', (req, res) => {
  const { tag } = req.body;
  if (!tag || typeof tag !== 'string' || !tag.trim()) return res.status(400).json({ error: 'tag required' });
  const clean = tag.trim().toLowerCase();
  db.prepare('INSERT OR IGNORE INTO tags (image_id, tag) VALUES (?, ?)').run(req.params.id, clean);
  res.json({ ok: true });
});

router.delete('/:id/tags/:tag', (req, res) => {
  db.prepare('DELETE FROM tags WHERE image_id = ? AND tag = ?').run(req.params.id, req.params.tag);
  res.json({ ok: true });
});

// Find visually similar images (perceptual hash within `threshold` bits)
router.get('/:id/similar', (req, res) => {
  const threshold = Math.max(0, Math.min(32, Number(req.query.threshold ?? 14)));
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 200)));
  const target = db.prepare('SELECT phash FROM images WHERE id = ?').get(req.params.id);
  if (!target?.phash) return res.json({ images: [], total: 0 });

  const rows = db.prepare(`
    SELECT id, path, filename, folder_path, size, mtime, width, height, format,
           favorite, file_hash, positive_prompt, negative_prompt, phash
    FROM images
    WHERE phash IS NOT NULL AND trashed_at IS NULL AND id != ?
  `).all(req.params.id);

  const scored = [];
  for (const r of rows) {
    const d = hammingDistance(target.phash, r.phash);
    if (d <= threshold) { const { phash, ...rest } = r; scored.push({ ...rest, distance: d }); }
  }
  scored.sort((a, b) => a.distance - b.distance);
  const images = scored.slice(0, limit);
  res.json({ images, total: images.length });
});

// Get all metadata for an image
router.get('/:id/metadata', (req, res) => {
  const img = db.prepare('SELECT id FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare('SELECT key, value FROM metadata WHERE image_id = ? ORDER BY key').all(req.params.id);
  res.json(rows);
});

// Bulk-set favorite level for many images at once — must be before /:id
router.patch('/favorite/bulk', (req, res) => {
  const { ids, favorite } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  if (favorite === undefined) return res.status(400).json({ error: 'favorite required' });
  const level = Math.max(0, Math.min(5, Number(favorite)));
  const stmt = db.prepare('UPDATE images SET favorite = ? WHERE id = ?');
  const tx = db.transaction((list) => { for (const id of list) stmt.run(level, id); });
  tx(ids);
  res.json({ ok: true, updated: ids.length, favorite: level });
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

// Delete images — soft delete: moves files to the trash. Starred images are
// protected and returned in `skipped`.
router.delete('/', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const result = await trashImages(ids);
  res.json({ ok: true, ...result });
});

// Restore images from the trash back to their original location.
router.post('/restore', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const result = await restoreImages(ids);
  res.json({ ok: true, ...result });
});

// Permanently delete from the trash. Empty body (or no ids) empties the trash.
router.delete('/trash', async (req, res) => {
  const { ids } = req.body || {};
  const result = await purgeImages(ids);
  res.json({ ok: true, ...result });
});

export default router;
