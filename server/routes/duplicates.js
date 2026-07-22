import { Router } from 'express';
import { unlink } from 'fs/promises';
import db from '../db.js';
import { findExactDuplicates, findPerceptualDuplicates, findSeedDuplicates } from '../duplicates.js';

const router = Router();

router.get('/', (req, res) => {
  const { type = 'exact', threshold = 8 } = req.query;
  try {
    const groups = type === 'perceptual'
      ? findPerceptualDuplicates(Number(threshold))
      : type === 'seed'
        ? findSeedDuplicates()
        : findExactDuplicates();
    res.json({ groups, total: groups.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const errors = [];
  const skipped = []; // starred images are protected from deletion
  for (const id of ids) {
    const img = db.prepare('SELECT path, favorite FROM images WHERE id = ?').get(id);
    if (!img) continue;
    if (img.favorite > 0) { skipped.push(id); continue; }
    try {
      await unlink(img.path);
    } catch (err) {
      if (err.code !== 'ENOENT') { errors.push({ id, error: err.message }); continue; }
    }
    db.prepare('DELETE FROM images WHERE id = ?').run(id);
  }
  res.json({ ok: true, errors, skipped });
});

export default router;
