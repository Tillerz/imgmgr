import { Router } from 'express';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import db from '../db.js';

const router = Router();

// Get folder tree
router.get('/', (req, res) => {
  const folders = db.prepare('SELECT * FROM folders ORDER BY path').all();
  res.json(folders);
});

// Create folder
router.post('/', async (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'path required' });
  try {
    await mkdir(folderPath, { recursive: true });
    const name = folderPath.split('/').filter(Boolean).pop() || folderPath;
    const parent = dirname(folderPath);
    db.prepare('INSERT OR IGNORE INTO folders (path, name, parent_path) VALUES (?, ?, ?)').run(folderPath, name, parent);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
