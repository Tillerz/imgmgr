import { Router } from 'express';
import { findExactDuplicates, findPerceptualDuplicates, findSeedDuplicates } from '../duplicates.js';
import { trashImages } from '../trash.js';

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
  // Soft-delete: duplicates go to the trash too, and starred images are protected.
  const result = await trashImages(ids);
  res.json({ ok: true, ...result });
});

export default router;
