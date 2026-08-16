#!/usr/bin/env node
// Hit the imgmgr API without starting the real server.
//
// Importing server/index.js would bind a port AND kick off a full scan, which
// collides with the server the user runs themselves. This mounts only the
// routers on a throwaway port, answers the requests, and exits.
//
//   node scripts/apicheck.mjs                       # smoke-test the main endpoints
//   node scripts/apicheck.mjs '/api/images?limit=2' # GET one path, print the JSON
//   node scripts/apicheck.mjs '/api/images/meta/keys' '/api/tags'
//
// Read-only: it only issues GETs. Writes belong in a rollback sandbox instead
// (see the imgmgr-safe-testing skill).
import express from 'express';
import imageRoutes from '../server/routes/images.js';
import folderRoutes from '../server/routes/folders.js';
import duplicateRoutes from '../server/routes/duplicates.js';
import tagRoutes from '../server/routes/tags.js';

const PORT = 3997; // deliberately not 3000 — never touch the user's server

const app = express();
app.use(express.json());
app.use('/api/images', imageRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/duplicates', duplicateRoutes);
app.use('/api/tags', tagRoutes);
const srv = app.listen(PORT);

const paths = process.argv.slice(2);
const targets = paths.length ? paths : [
  '/api/images?limit=3',
  '/api/images/counts',
  '/api/images/missing/count',
  '/api/images/meta/keys',
  '/api/folders',
  '/api/tags',
];

// Keep smoke-test output short; print full bodies only for explicit requests.
const brief = (body) => {
  if (Array.isArray(body)) return `array(${body.length}) ${JSON.stringify(body.slice(0, 3))}`;
  if (body && Array.isArray(body.images)) {
    return `total=${body.total} snapshot=${body.snapshot ?? '-'} ids=[${body.images.map(i => i.id).join(',')}]`;
  }
  return JSON.stringify(body);
};

let failed = 0;
try {
  for (const p of targets) {
    const t = Date.now();
    try {
      const res = await fetch(`http://localhost:${PORT}${p}`);
      const body = await res.json();
      const out = paths.length ? JSON.stringify(body, null, 2) : brief(body);
      console.log(`${res.ok ? 'ok  ' : 'ERR '} ${String(res.status)} ${p}  (${Date.now() - t}ms)\n     ${out}`);
      if (!res.ok) failed++;
    } catch (e) {
      console.log(`ERR  --- ${p}\n     ${e.message}`);
      failed++;
    }
  }
} finally {
  srv.close();
  console.log(failed ? `\n${failed} request(s) failed` : '\nall requests ok');
  process.exit(failed ? 1 : 0);
}
