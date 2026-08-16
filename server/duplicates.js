import db from './db.js';

// Returns groups of images with identical file content
export function findExactDuplicates() {
  const rows = db.prepare(`
    SELECT file_hash, COUNT(*) as cnt
    FROM images WHERE file_hash IS NOT NULL AND trashed_at IS NULL
    GROUP BY file_hash HAVING cnt > 1
  `).all();

  const groups = [];
  for (const { file_hash } of rows) {
    const images = db.prepare(`
      SELECT id, path, filename, folder_path, size, mtime, width, height, favorite
      FROM images WHERE file_hash = ? AND trashed_at IS NULL ORDER BY mtime ASC
    `).all(file_hash);
    groups.push({ hash: file_hash, type: 'exact', images });
  }
  return groups;
}

// NOTE: a "perceptual" duplicate mode used to live here. It compared every image
// against every other one — O(n²), ~4.8 billion comparisons at 98k images, which
// blocked the (single-threaded, synchronous) server for roughly two hours and
// still produced poor groupings. Removed. Per-image "find similar" from the
// lightbox covers the same need cheaply, since it scans against one hash.

// Returns groups of images sharing the same seed (last number before extension in filename)
export function findSeedDuplicates() {
  const rows = db.prepare(
    'SELECT id, path, filename, folder_path, size, mtime, width, height, favorite FROM images WHERE trashed_at IS NULL ORDER BY mtime ASC'
  ).all();

  const SEED_RE = /-(\d+)\.[^.]+$/;

  const bySeed = new Map();
  for (const row of rows) {
    const m = SEED_RE.exec(row.filename);
    if (!m) continue;
    const seed = m[1];
    if (!bySeed.has(seed)) bySeed.set(seed, []);
    bySeed.get(seed).push(row);
  }

  return [...bySeed.values()]
    .filter(imgs => imgs.length > 1)
    .map(imgs => ({ type: 'seed', seed: SEED_RE.exec(imgs[0].filename)[1], images: imgs }));
}
