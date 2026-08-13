import { readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import db from './db.js';
import { config, TRASH_DIR } from './config.js';
import { extractMetadata } from './meta.js';
import { getImageInfo, computeFileHash, computePHash, ensureThumbnail } from './thumbnails.js';

const EXT_RE = new RegExp(`\\.(${config.supportedExtensions.join('|')})$`, 'i');

// Max length of a single metadata value we'll store. Raw SD parameter strings
// (prompt + negative + template + params, all in one UserComment) routinely run
// several KB for detailed prompts — this used to be capped at 4096, which
// silently dropped the whole UserComment for long prompts, breaking the
// client's authoritative re-parse and leaving it stuck on the (possibly
// mis-parsed) DB columns. This still guards against pathological/binary blobs.
export const META_VALUE_MAX_LEN = 100_000;

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
    negative_prompt=excluded.negative_prompt, indexed_at=excluded.indexed_at,
    missing_at=NULL
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
    if (strVal.length < META_VALUE_MAX_LEN) insertMeta.run(imageId, key, strVal);
  }
}

// Carry database rows over to files that changed location.
//
// A moved or renamed file looks like two unrelated things to a path-keyed
// scanner: an unknown new path (indexed as a fresh row) and a stale old path
// (pruned at the end of the scan, taking its star rating, tags, caption and
// metadata with it via ON DELETE CASCADE). Matching the two by content hash
// lets us just update the row's path instead, so its id — and everything
// hanging off it — survives. Must run before indexing and pruning.
//
// Returns the number of rows relocated.
export async function reconcileMoves(diskPaths, onProgress) {
  const rows = db.prepare('SELECT id, path, filename, file_hash FROM images').all();
  const known = new Set(rows.map(r => r.path));
  // Rows whose file is gone. Trashed rows point into the trash dir and still
  // exist on disk, so they never show up here.
  const missing = rows.filter(r => r.file_hash && !diskPaths.has(r.path));
  if (!missing.length) return 0; // nothing vanished — skip hashing entirely

  const unknown = [];
  for (const p of diskPaths) if (!known.has(p)) unknown.push(p);
  if (!unknown.length) return 0; // nothing appeared to match them against

  // Only the files that aren't already indexed need hashing, so an ordinary
  // scan (no moves) never reaches this loop.
  const byHash = new Map();
  let hashed = 0;
  for (const p of unknown) {
    try {
      const h = await computeFileHash(p);
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(p);
    } catch { /* unreadable file — just leave it for the normal index pass */ }
    if (++hashed % 100 === 0) onProgress?.({ hashed, total: unknown.length });
  }
  for (const list of byHash.values()) list.sort(); // deterministic pairing

  const updatePath = db.prepare(
    'UPDATE images SET path = ?, folder_path = ?, filename = ? WHERE id = ?'
  );
  const claimed = new Set();
  let moved = 0;

  // Claim an unindexed file with this row's content hash. `sameName` restricts
  // to an identical filename, which is what a folder move/rename looks like.
  const take = (row, sameName) => {
    const candidates = byHash.get(row.file_hash);
    if (!candidates) return false;
    for (const p of candidates) {
      if (claimed.has(p)) continue;
      if (sameName && basename(p) !== row.filename) continue;
      claimed.add(p);
      updatePath.run(p, dirname(p), basename(p), row.id);
      moved++;
      return true;
    }
    return false;
  };

  db.transaction(() => {
    // Same-filename matches first (a moved/renamed folder), so they can't be
    // stolen by the looser content-only pass that catches renamed files. When
    // several identical copies move at once the pairing is arbitrary but
    // deterministic — the content is the same either way.
    const leftover = missing.filter(r => !take(r, true));
    for (const r of leftover) take(r, false);
  })();

  return moved;
}

// Flag rows whose file is gone, and clear the flag for any that came back.
//
// Deliberately non-destructive: removable media and network shares disappear
// and reappear all the time, and a vanished path is no reason to throw away a
// rating, tags, a caption or a cached thumbnail. Because nothing is deleted
// here, a share that fails to mount can't cost the user any data — rows are
// only ever removed by an explicit purge (DELETE /api/images/missing).
//
// Returns { missing, returned } — how many rows changed state this pass.
export function syncMissingFlags() {
  const now = Date.now();
  const markMissing = db.prepare('UPDATE images SET missing_at = ? WHERE id = ? AND missing_at IS NULL');
  const markPresent = db.prepare('UPDATE images SET missing_at = NULL WHERE id = ? AND missing_at IS NOT NULL');
  const rows = db.prepare('SELECT id, path, missing_at FROM images').all();
  let missing = 0, returned = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (existsSync(row.path)) {
        if (row.missing_at != null) { markPresent.run(row.id); returned++; }
      } else if (row.missing_at == null) {
        markMissing.run(now, row.id); missing++;
      }
    }
  })();
  return { missing, returned };
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
  let indexed = 0, skipped = 0, errors = 0, moved = 0, missing = 0, returned = 0;

  try {
    // Index folders
    for (const folderPath of collectFolders(config.imageRoot)) {
      const name = basename(folderPath) || folderPath;
      const parent = dirname(folderPath) === folderPath ? null : dirname(folderPath);
      upsertFolder.run(folderPath, name, parent);
    }

    // Walk once and reuse the list: move reconciliation needs the full set of
    // paths on disk before anything is indexed or pruned.
    const files = [...walkFiles(config.imageRoot)];
    moved = await reconcileMoves(new Set(files), (p) => onProgress?.({ ...p, phase: 'moves' }));

    // Index files
    for (const filePath of files) {
      try {
        await indexFile(filePath);
        indexed++;
        if (onProgress) onProgress({ indexed, errors });
      } catch {
        errors++;
      }
    }

    ({ missing, returned } = syncMissingFlags());
  } finally {
    scanRunning = false;
  }

  return { status: 'done', indexed, skipped, errors, moved, missing, returned };
}
