import { Router } from 'express';
import db from '../db.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT tag FROM tags ORDER BY tag').all();
  res.json(rows.map(r => r.tag));
});

router.post('/bulk', (req, res) => {
  const { ids, tag } = req.body;
  if (!Array.isArray(ids) || !tag?.trim()) return res.status(400).json({ error: 'ids and tag required' });
  const clean = tag.trim().toLowerCase();
  const stmt = db.prepare('INSERT OR IGNORE INTO tags (image_id, tag) VALUES (?, ?)');
  db.transaction(() => { for (const id of ids) stmt.run(id, clean); })();
  res.json({ ok: true });
});

router.delete('/bulk', (req, res) => {
  const { ids, tag } = req.body;
  if (!Array.isArray(ids) || !tag) return res.status(400).json({ error: 'ids and tag required' });
  const stmt = db.prepare('DELETE FROM tags WHERE image_id = ? AND tag = ?');
  db.transaction(() => { for (const id of ids) stmt.run(id, tag); })();
  res.json({ ok: true });
});

export default router;
