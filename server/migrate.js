import db from './db.js';
import { parseGenerationParams, GEN_PARAM_KEYS } from './meta.js';
import { computePHash, PHASH_VERSION } from './thumbnails.js';

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
