import { Router } from 'express';
import { findExactDuplicates, findSeedDuplicates } from '../duplicates.js';
import { trashImages } from '../trash.js';

const router = Router();

router.get('/', (req, res) => {
  const { type = 'exact' } = req.query;
  if (type === 'perceptual') {
    return res.status(410).json({
      error: 'the perceptual duplicate mode was removed',
      hint: 'use "exact" or "seed" here, or the per-image similar search: GET /api/images/:id/similar',
    });
  }
  try {
    const groups = type === 'seed' ? findSeedDuplicates() : findExactDuplicates();
    res.json({ groups, total: groups.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  // Soft-delete: duplicates go to the trash too, and starred images are protected.
  const result = await trashImages(ids);
  res.json({ ok: true, ...result });
});

export default router;
