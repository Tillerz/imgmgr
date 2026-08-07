import db from './db.js';
import { parseGenerationParams, GEN_PARAM_KEYS, extractMetadata } from './meta.js';
import { computePHash, PHASH_VERSION } from './thumbnails.js';
import { META_VALUE_MAX_LEN } from './scanner.js';

// Bump whenever parseSDParameters (in meta.js) or the metadata storage cap
// changes in a way that could fix previously mis-extracted data.
const PROMPT_FIX_VERSION = 1;

// One-time backfill: existing images stored the SD parameters as one big
// UserComment/parameters string. Parse out discrete facet keys (Model, Sampler,
// …) so the facet filters work without a full re-scan. Guarded by user_version.
export function backfillGenParams() {
  const version = db.pragma('user_version', { simple: true });
  if (version >= 1) return { skipped: true, version };

  const rows = db.prepare(
    "SELECT image_id, value FROM metadata WHERE key IN ('UserComment','parameters','Parameters')"
  ).all();

  // One source string per image (first wins).
  const byImage = new Map();
  for (const r of rows) if (!byImage.has(r.image_id)) byImage.set(r.image_id, r.value);

  const insert = db.prepare('INSERT INTO metadata (image_id, key, value) VALUES (?, ?, ?)');
  let imagesUpdated = 0, rowsAdded = 0;

  const run = db.transaction(() => {
    for (const [imageId, value] of byImage) {
      if (typeof value !== 'string') continue;
      const gp = parseGenerationParams(value);
      let added = 0;
      for (const k of GEN_PARAM_KEYS) {
        if (gp[k] != null && gp[k] !== '') { insert.run(imageId, k, String(gp[k])); added++; }
      }
      if (added) { imagesUpdated++; rowsAdded += added; }
    }
    db.pragma('user_version = 1');
  });
  run();

  return { imagesUpdated, rowsAdded };
}

// One-time recompute of every image's perceptual hash after the pHash algorithm
// changed (see PHASH_VERSION in thumbnails.js). Old and new hashes are not
// comparable, so a stale hash silently breaks "find similar". Reads each file, so
// it is slow (~file I/O per image) and runs in the background off the main scan.
// Guarded by `phash_version` in a tiny meta table; only rehashes when out of date.
export async function recomputePhashes(onProgress) {
  db.prepare('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)').run();
  const cur = Number(
    db.prepare("SELECT value FROM app_meta WHERE key = 'phash_version'").get()?.value ?? 0
  );
  if (cur >= PHASH_VERSION) return { skipped: true, version: cur };

  const rows = db.prepare('SELECT id, path FROM images WHERE phash IS NOT NULL').all();
  const update = db.prepare('UPDATE images SET phash = ? WHERE id = ?');
  let done = 0, updated = 0, failed = 0;

  for (const r of rows) {
    const h = await computePHash(r.path);
    if (h) { update.run(h, r.id); updated++; } else { failed++; }
    if (++done % 500 === 0) onProgress?.({ done, total: rows.length });
  }

  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('phash_version', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(PHASH_VERSION));

  return { total: rows.length, updated, failed };
}

// One-time re-extraction of metadata for every image, to fix two compounding
// bugs: (1) parseSDParameters used to swallow an entire Template section into
// "negative" when the Negative prompt was empty, polluting positive_prompt /
// negative_prompt; (2) the metadata table used to drop any raw value over 4096
// chars, silently discarding long UserComment strings (common with detailed
// prompts) and leaving the client with no source to re-parse from. Re-reads
// each file (fast — EXIF/tEXt parsing only, no image decode) and rewrites both
// the images.positive_prompt/negative_prompt columns and the raw metadata rows.
// Guarded by `prompt_fix_version`; only runs once (again if bumped further).
export async function recomputePrompts(onProgress) {
  db.prepare('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)').run();
  const cur = Number(
    db.prepare("SELECT value FROM app_meta WHERE key = 'prompt_fix_version'").get()?.value ?? 0
  );
  if (cur >= PROMPT_FIX_VERSION) return { skipped: true, version: cur };

  const rows = db.prepare('SELECT id, path FROM images').all();
  const updateImage = db.prepare('UPDATE images SET positive_prompt = ?, negative_prompt = ? WHERE id = ?');
  const deleteMeta = db.prepare('DELETE FROM metadata WHERE image_id = ?');
  const insertMeta = db.prepare('INSERT INTO metadata (image_id, key, value) VALUES (?, ?, ?)');
  const applyOne = db.transaction((imageId, meta) => {
    updateImage.run(meta.positive_prompt || null, meta.negative_prompt || null, imageId);
    deleteMeta.run(imageId);
    for (const [key, val] of Object.entries(meta.raw || {})) {
      if (val == null) continue;
      const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (strVal.length < META_VALUE_MAX_LEN) insertMeta.run(imageId, key, strVal);
    }
  });

  let done = 0, updated = 0, failed = 0;
  for (const r of rows) {
    try {
      const meta = await extractMetadata(r.path);
      applyOne(r.id, meta);
      updated++;
    } catch { failed++; }
    if (++done % 1000 === 0) onProgress?.({ done, total: rows.length });
  }

  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('prompt_fix_version', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(PROMPT_FIX_VERSION));

  return { total: rows.length, updated, failed };
}
