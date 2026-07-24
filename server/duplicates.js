import db from './db.js';
import { hammingDistance } from './thumbnails.js';

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

// Returns groups of images that look visually similar (perceptual hash distance <= threshold)
export function findPerceptualDuplicates(threshold = 8) {
  const rows = db.prepare(`
    SELECT id, path, filename, folder_path, size, mtime, width, height, favorite, phash, file_hash
    FROM images WHERE phash IS NOT NULL AND trashed_at IS NULL
    ORDER BY id
  `).all();

  const used = new Set();
  const groups = [];

  for (let i = 0; i < rows.length; i++) {
    if (used.has(rows[i].id)) continue;
    const group = [rows[i]];
    used.add(rows[i].id);

    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(rows[j].id)) continue;
      if (rows[i].file_hash === rows[j].file_hash) continue; // already caught by exact
      if (hammingDistance(rows[i].phash, rows[j].phash) <= threshold) {
        group.push(rows[j]);
        used.add(rows[j].id);
      }
    }

    if (group.length > 1) {
      groups.push({ type: 'perceptual', images: group });
    }
  }
  return groups;
}

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
