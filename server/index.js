import express from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { createServer as createViteServer } from 'vite';
import { config, ROOT } from './config.js';
import db from './db.js';
import { runScan, isScanRunning } from './scanner.js';
import { backfillGenParams } from './migrate.js';
import { startWatcher } from './watcher.js';
import imageRoutes from './routes/images.js';
import folderRoutes from './routes/folders.js';
import duplicateRoutes from './routes/duplicates.js';
import tagRoutes from './routes/tags.js';
import { ensureThumbnail } from './thumbnails.js';
import { addClient, broadcast } from './events.js';

const app = express();

// Minimal CORS: allow any origin (server is intended for local, trusted use).
// Replaces the `cors` package to keep the dependency tree small.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

// Thumbnail route (short-circuit before other routes for performance)
app.get('/api/thumb/:id', async (req, res) => {
  const img = db.prepare('SELECT path, file_hash FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();
  try {
    const tp = await ensureThumbnail(img.path, img.file_hash);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(tp);
  } catch {
    res.status(500).end();
  }
});

// Full image route
app.get('/api/full/:id', (req, res) => {
  const img = db.prepare('SELECT path FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();
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
  res.json({ imageRoot: config.imageRoot, thumbnailSize: config.thumbnailSize });
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
  if (config.scanOnStart) {
    console.log('Starting initial scan...');
    runScan(({ indexed }) => {
      if (indexed % 50 === 0) process.stdout.write(`\rIndexed ${indexed} images...`);
    }).then(r => {
      console.log(`\nScan done: ${r.indexed} images, ${r.errors} errors`);
      broadcast('images:changed');
      startWatcher();
    }).catch(e => console.error('Scan error:', e));
  } else {
    startWatcher();
  }
});
