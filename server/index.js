import express from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { createServer as createViteServer } from 'vite';
import { config, ROOT } from './config.js';
import db from './db.js';
import { runScan, isScanRunning } from './scanner.js';
import { backfillGenParams, recomputePhashes, recomputePrompts } from './migrate.js';
import { startWatcher } from './watcher.js';
import imageRoutes from './routes/images.js';
import folderRoutes from './routes/folders.js';
import duplicateRoutes from './routes/duplicates.js';
import tagRoutes from './routes/tags.js';
import { ensureThumbnail } from './thumbnails.js';
import { addClient, broadcast } from './events.js';

const app = express();

// Minimal CORS, locked to the origins the UI is actually served on. Replaces the
// `cors` package to keep the dependency tree small.
//
// There is no authentication, so a wide-open policy would let any page the user
// happens to have open drive this API — including the endpoints that move and
// delete files. Same-origin requests from the UI carry a matching Origin (or
// none at all, e.g. curl), so this costs the app nothing.
const ALLOW_ANY_ORIGIN = config.allowedOrigins.includes('*');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ALLOW_ANY_ORIGIN || !origin || config.allowedOrigins.includes(origin);

  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ANY_ORIGIN ? '*' : origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(allowed ? 204 : 403);

  // Only state-changing requests are refused outright; reads stay open so
  // existing tooling and bookmarks keep working.
  if (!allowed && !SAFE_METHODS.has(req.method)) {
    return res.status(403).json({
      error: 'cross-origin request refused',
      hint: 'add this origin to "allowedOrigins" in config.json if it is expected',
    });
  }
  next();
});
app.use(express.json());

// Thumbnail route (short-circuit before other routes for performance)
app.get('/api/thumb/:id', async (req, res) => {
  const img = db.prepare('SELECT path, file_hash FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();
  try {
    // Thumbnails are cached by content hash, so an offline original still
    // renders from cache — ensureThumbnail only touches the source file when
    // no thumbnail exists yet.
    const tp = await ensureThumbnail(img.path, img.file_hash);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(tp);
  } catch {
    // Source is unavailable and nothing was cached.
    res.status(404).end();
  }
});

// Full image route
app.get('/api/full/:id', (req, res) => {
  const img = db.prepare('SELECT path, missing_at FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();
  // The original can't be served from cache, so say plainly that it's offline
  // rather than letting sendFile fail with a generic error.
  if (img.missing_at != null || !existsSync(img.path)) {
    return res.status(410).json({ error: 'file offline', path: img.path });
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(img.path);
});

app.use('/api/images', imageRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/duplicates', duplicateRoutes);
app.use('/api/tags', tagRoutes);

// Scan endpoint
app.post('/api/scan', async (req, res) => {
  if (isScanRunning()) return res.json({ status: 'already running' });
  res.json({ status: 'started' });
  // Run scan in background, log progress
  runScan(({ indexed, errors }) => {
    if (indexed % 100 === 0) console.log(`Scan: ${indexed} indexed, ${errors} errors`);
  }).then(r => console.log('Scan complete:', r));
});

app.get('/api/scan/status', (req, res) => {
  res.json({ running: isScanRunning() });
});

// SSE endpoint — clients subscribe here for live updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  addClient(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => clearInterval(ping));
});

// Config endpoint (read-only, for client to know imageRoot etc.)
app.get('/api/config', (req, res) => {
  res.json({ imageRoot: config.imageRoot, thumbnailSize: config.thumbnailSize, sdnextUrl: config.sdnextUrl, captionModel: config.captionModel });
});

// Serve client: Vite middleware in dev, static dist/ in production
const distDir = join(ROOT, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => res.sendFile(join(distDir, 'index.html')));
} else {
  // Dev mode: mount Vite as middleware so everything runs on one port
  const vite = await createViteServer({
    root: join(ROOT, 'client'),
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.listen(config.port, () => {
  console.log(`imgmgr server on http://localhost:${config.port}`);
  console.log(`Image root: ${config.imageRoot}`);
  // One-time backfill of discrete generation params for the facet filters.
  try {
    const bf = backfillGenParams();
    if (!bf.skipped) console.log(`Backfilled gen params: ${bf.rowsAdded} rows across ${bf.imagesUpdated} images`);
  } catch (e) { console.error('Gen-param backfill error:', e); }
  // One-time perceptual-hash recompute after a pHash algorithm change. Runs in the
  // background (reads every file) so it never blocks the server or the scan.
  recomputePhashes(({ done, total }) => process.stdout.write(`\rRehashing ${done}/${total}...`))
    .then((r) => { if (!r.skipped) console.log(`\npHash recompute: ${r.updated} updated, ${r.failed} failed`); })
    .catch((e) => console.error('pHash recompute error:', e));
  // One-time re-extraction of prompt/negative-prompt/raw metadata after fixing a
  // parser bug that could swallow a Template section into "negative" (and a
  // storage cap that could drop long UserComment strings entirely). Background,
  // non-blocking — see recomputePrompts in migrate.js.
  recomputePrompts(({ done, total }) => process.stdout.write(`\rFixing prompts ${done}/${total}...`))
    .then((r) => { if (!r.skipped) console.log(`\nPrompt fix: ${r.updated} updated, ${r.failed} failed`); })
    .catch((e) => console.error('Prompt fix error:', e));
  if (config.scanOnStart) {
    console.log('Starting initial scan...');
    runScan(({ indexed, phase, hashed, total }) => {
      if (phase === 'moves') process.stdout.write(`\rChecking for moved files ${hashed}/${total}...`);
      else if (indexed % 50 === 0) process.stdout.write(`\rIndexed ${indexed} images...`);
    }).then(r => {
      if (r.moved) console.log(`\nRelocated ${r.moved} moved/renamed file(s), keeping their ratings and tags`);
      if (r.missing) console.log(`${r.missing} file(s) are offline — entries and thumbnails kept (see "Delete orphaned data" in the UI)`);
      if (r.returned) console.log(`${r.returned} previously offline file(s) are back`);
      console.log(`\nScan done: ${r.indexed} images, ${r.errors} errors`);
      broadcast('images:changed');
      startWatcher();
    }).catch(e => console.error('Scan error:', e));
  } else {
    startWatcher();
  }
});
