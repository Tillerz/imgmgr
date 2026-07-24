import { readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import db from './db.js';
import { config, TRASH_DIR } from './config.js';
import { extractMetadata } from './meta.js';
import { getImageInfo, computeFileHash, computePHash, ensureThumbnail } from './thumbnails.js';

const EXT_RE = new RegExp(`\\.(${config.supportedExtensions.join('|')})$`, 'i');

let scanRunning = false;
export function isScanRunning() { return scanRunning; }

export const upsertFolder = db.prepare(`
  INSERT INTO folders (path, name, parent_path) VALUES (?, ?, ?)
  ON CONFLICT(path) DO NOTHING
`);

const upsertImage = db.prepare(`
  INSERT INTO images (path, filename, folder_path, size, mtime, width, height, format, file_hash, phash, thumbnail_path, positive_prompt, negative_prompt, indexed_at)
  VALUES (@path, @filename, @folder_path, @size, @mtime, @width, @height, @format, @file_hash, @phash, @thumbnail_path, @positive_prompt, @negative_prompt, @indexed_at)
  ON CONFLICT(path) DO UPDATE SET
    size=excluded.size, mtime=excluded.mtime, width=excluded.width, height=excluded.height,
    format=excluded.format, file_hash=excluded.file_hash, phash=excluded.phash,
    thumbnail_path=excluded.thumbnail_path, positive_prompt=excluded.positive_prompt,
    negative_prompt=excluded.negative_prompt, indexed_at=excluded.indexed_at
  RETURNING id
`);

const deleteMetaForImage = db.prepare(`DELETE FROM metadata WHERE image_id = ?`);
const insertMeta = db.prepare(`INSERT INTO metadata (image_id, key, value) VALUES (?, ?, ?)`);
const getImageByPath = db.prepare(`SELECT id, mtime FROM images WHERE path = ?`);

export async function indexFile(filePath) {
  const stat = statSync(filePath);
  const mtime = Math.floor(stat.mtimeMs);
  const existing = getImageByPath.get(filePath);
  if (existing && existing.mtime === mtime) return; // unchanged

  const filename = basename(filePath);
  const folder_path = dirname(filePath);

  const [info, fileHash] = await Promise.all([
    getImageInfo(filePath),
    computeFileHash(filePath),
  ]);

  const [phash, meta, thumbPath] = await Promise.all([
    computePHash(filePath),
    extractMetadata(filePath),
    ensureThumbnail(filePath, fileHash),
  ]);

  const row = {
    path: filePath,
    filename,
    folder_path,
    size: stat.size,
    mtime,
    width: info.width,
    height: info.height,
    format: info.format,
    file_hash: fileHash,
    phash: phash || null,
    thumbnail_path: thumbPath,
    positive_prompt: meta.positive_prompt || null,
    negative_prompt: meta.negative_prompt || null,
    indexed_at: Date.now(),
  };

  const upserted = upsertImage.get(row);
  const imageId = upserted?.id;
  if (!imageId) return;

  // Store metadata key/value pairs
  deleteMetaForImage.run(imageId);
  const rawMeta = meta.raw || {};
  for (const [key, val] of Object.entries(rawMeta)) {
    if (val == null) continue;
    const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (strVal.length < 4096) insertMeta.run(imageId, key, strVal);
  }
}

function collectFolders(root) {
  const folders = new Set();
  function walk(dir) {
    folders.add(dir);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (full === TRASH_DIR) continue; // never index the trash folder
      walk(full);
    }
  }
  walk(root);
  return folders;
}

function* walkFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (full === TRASH_DIR) continue; // skip trashed files
      yield* walkFiles(full);
    } else if (EXT_RE.test(e.name)) yield full;
  }
}

export async function runScan(onProgress) {
  if (scanRunning) return { status: 'already running' };
  if (!existsSync(config.imageRoot)) return { status: 'imageRoot not found', path: config.imageRoot };

  scanRunning = true;
  let indexed = 0, skipped = 0, errors = 0;

  try {
    // Index folders
    for (const folderPath of collectFolders(config.imageRoot)) {
      const name = basename(folderPath) || folderPath;
      const parent = dirname(folderPath) === folderPath ? null : dirname(folderPath);
      upsertFolder.run(folderPath, name, parent);
    }

    // Index files
    for (const filePath of walkFiles(config.imageRoot)) {
      try {
        await indexFile(filePath);
        indexed++;
        if (onProgress) onProgress({ indexed, errors });
      } catch {
        errors++;
      }
    }

    // Remove DB entries for files that no longer exist on disk
    const allPaths = db.prepare('SELECT id, path FROM images').all();
    const deleteStmt = db.prepare('DELETE FROM images WHERE id = ?');
    for (const row of allPaths) {
      if (!existsSync(row.path)) deleteStmt.run(row.id);
    }
  } finally {
    scanRunning = false;
  }

  return { status: 'done', indexed, skipped, errors };
}
