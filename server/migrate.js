import db from './db.js';
import { parseGenerationParams, GEN_PARAM_KEYS } from './meta.js';

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
