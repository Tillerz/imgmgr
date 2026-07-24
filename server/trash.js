import { rename, mkdir, copyFile, unlink } from 'fs/promises';
import { join, dirname, basename } from 'path';
import db from './db.js';
import { TRASH_DIR } from './config.js';

// Move a file, falling back to copy+unlink across filesystem boundaries.
async function moveFile(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await copyFile(src, dest);
      await unlink(src);
    } else throw err;
  }
}

// Soft-delete: move each image's file into TRASH_DIR and flag the row.
// Starred images (favorite > 0) are protected and reported in `skipped`.
export async function trashImages(ids) {
  const errors = [];
  const skipped = [];
  const trashed = [];
  const now = Date.now();
  for (const id of ids) {
    const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!img || img.trashed_at) continue;
    if (img.favorite > 0) { skipped.push(id); continue; }
    const dest = join(TRASH_DIR, `${id}__${img.filename}`);
    try {
      await moveFile(img.path, dest);
      db.prepare('UPDATE images SET original_path = path, path = ?, trashed_at = ? WHERE id = ?')
        .run(dest, now, id);
      trashed.push(id);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Original file already gone — flag the row anyway so it leaves the view.
        db.prepare('UPDATE images SET original_path = path, trashed_at = ? WHERE id = ?').run(now, id);
        trashed.push(id);
      } else {
        errors.push({ id, error: err.message });
      }
    }
  }
  return { errors, skipped, trashed };
}

// Restore trashed images back to their original path and clear the flag.
export async function restoreImages(ids) {
  const errors = [];
  const restored = [];
  for (const id of ids) {
    const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!img || !img.trashed_at) continue;
    const target = img.original_path || img.path;
    try {
      if (img.path && img.path !== target) {
        try { await moveFile(img.path, target); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      } else {
        await mkdir(dirname(target), { recursive: true });
      }
      db.prepare('UPDATE images SET path = ?, folder_path = ?, original_path = NULL, trashed_at = NULL WHERE id = ?')
        .run(target, dirname(target), id);
      // Make sure the restored image's folder exists in the folder tree.
      db.prepare('INSERT OR IGNORE INTO folders (path, name, parent_path) VALUES (?, ?, ?)')
        .run(dirname(target), basename(dirname(target)), dirname(dirname(target)));
      restored.push(id);
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }
  return { errors, restored };
}

// Permanently delete trashed images. With no ids (or empty array), empties the
// entire trash. Only rows already in the trash are affected.
export async function purgeImages(ids) {
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const q = db.prepare('SELECT id, path FROM images WHERE id = ? AND trashed_at IS NOT NULL');
    rows = ids.map(id => q.get(id)).filter(Boolean);
  } else {
    rows = db.prepare('SELECT id, path FROM images WHERE trashed_at IS NOT NULL').all();
  }
  const errors = [];
  let purged = 0;
  for (const img of rows) {
    try {
      await unlink(img.path);
    } catch (err) {
      if (err.code !== 'ENOENT') { errors.push({ id: img.id, error: err.message }); continue; }
    }
    db.prepare('DELETE FROM images WHERE id = ?').run(img.id);
    purged++;
  }
  return { errors, purged };
}
