#!/usr/bin/env node
// Print the state of the imgmgr database: schema, counts, migration markers.
// Read-only — safe to run against the live library at any time.
//
//   node scripts/dbstat.mjs
//
// Avoids hand-writing throwaway `node -e "import('./server/db.js')..."` one-liners.
import db from '../server/db.js';

const one = (sql, ...a) => db.prepare(sql).get(...a);
const num = (sql, ...a) => one(sql, ...a)?.n ?? 0;
const row = (label, value) => console.log('  ' + label.padEnd(30) + value);

console.log('\n=== images ===');
row('total rows', num('SELECT COUNT(*) n FROM images'));
row('live (not trashed)', num('SELECT COUNT(*) n FROM images WHERE trashed_at IS NULL'));
row('in trash', num('SELECT COUNT(*) n FROM images WHERE trashed_at IS NOT NULL'));
row('offline (missing_at set)', num('SELECT COUNT(*) n FROM images WHERE missing_at IS NOT NULL'));
row('starred (favorite > 0)', num('SELECT COUNT(*) n FROM images WHERE favorite > 0 AND trashed_at IS NULL'));
row('captioned', num("SELECT COUNT(*) n FROM images WHERE caption IS NOT NULL AND caption != ''"));
row('with phash', num('SELECT COUNT(*) n FROM images WHERE phash IS NOT NULL'));
row('with a prompt', num("SELECT COUNT(*) n FROM images WHERE positive_prompt IS NOT NULL AND positive_prompt != ''"));

console.log('\n=== related tables ===');
row('folders', num('SELECT COUNT(*) n FROM folders'));
row('metadata rows', num('SELECT COUNT(*) n FROM metadata'));
row('distinct metadata keys', num('SELECT COUNT(DISTINCT key) n FROM metadata'));
row('tagged images', num('SELECT COUNT(DISTINCT image_id) n FROM tags'));
row('distinct tags', num('SELECT COUNT(DISTINCT tag) n FROM tags'));

console.log('\n=== migrations ===');
row('PRAGMA user_version', db.pragma('user_version', { simple: true }));
try {
  const rows = db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();
  if (!rows.length) console.log('  app_meta                      (empty)');
  for (const r of rows) row('app_meta.' + r.key, r.value);
} catch {
  console.log('  app_meta                      (table not created yet)');
}

console.log('\n=== images columns ===');
console.log('  ' + db.prepare('PRAGMA table_info(images)').all().map(c => c.name).join(', '));

// Cheap integrity signals that have bitten this project before.
console.log('\n=== sanity ===');
const dupPaths = num('SELECT COUNT(*) n FROM (SELECT path FROM images GROUP BY path HAVING COUNT(*) > 1)');
row('duplicate paths (want 0)', dupPaths);
const tieRisk = num('SELECT COUNT(*) n FROM images WHERE trashed_at IS NULL')
  - num('SELECT COUNT(DISTINCT mtime) n FROM images WHERE trashed_at IS NULL');
row('images sharing an mtime', tieRisk);
row('orphan metadata rows', num('SELECT COUNT(*) n FROM metadata m LEFT JOIN images i ON i.id = m.image_id WHERE i.id IS NULL'));
console.log('');
process.exit(0);
