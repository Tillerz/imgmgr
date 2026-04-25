import chokidar from 'chokidar';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { config } from './config.js';
import db from './db.js';
import { indexFile, upsertFolder } from './scanner.js';
import { broadcast } from './events.js';

const EXT_RE = new RegExp(`\\.(${config.supportedExtensions.join('|')})$`, 'i');
const POLL_INTERVAL = config.watchInterval ?? 5000;

function getTodayFolder() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return join(config.imageRoot, String(y), `${y}-${m}-${d}`);
}

function msUntilMidnight() {
  const now = new Date();
  const rollover = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0);
  return rollover - now;
}

function ensureFolder(folderPath) {
  upsertFolder.run(folderPath, basename(folderPath), dirname(folderPath));
}

let activeWatcher = null;
let rolloverTimer = null;

function watchDay(dayFolder) {
  if (activeWatcher) activeWatcher.close();
  if (rolloverTimer) clearTimeout(rolloverTimer);

  // If today's folder exists watch it directly (depth 0 = no recursion needed).
  // If it doesn't exist yet, watch the year folder at depth 1 so we catch the
  // moment the day folder is created, then switch immediately.
  const todayExists = existsSync(dayFolder);
  const watchPath = todayExists ? dayFolder : dirname(dayFolder);
  const depth     = todayExists ? 0 : 1;

  console.log(`[watch] ${todayExists ? dayFolder : `${watchPath} (waiting for ${basename(dayFolder)})`} — poll ${POLL_INTERVAL / 1000}s`);

  activeWatcher = chokidar.watch(watchPath, {
    usePolling: true,          // required: /mnt/sd is DrvFs, inotify doesn't fire
    interval: POLL_INTERVAL,
    binaryInterval: POLL_INTERVAL,
    ignoreInitial: true,       // startup scan already handled existing files
    depth,
    awaitWriteFinish: {        // wait until file stops growing before indexing
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  activeWatcher.on('add', async (filePath) => {
    if (!EXT_RE.test(filePath)) return;
    try {
      ensureFolder(dirname(filePath));
      await indexFile(filePath);
      broadcast('images:changed');
      console.log(`[watch] +${filePath}`);
    } catch (err) {
      console.warn(`[watch] index error: ${err.message}`);
    }
  });

  activeWatcher.on('change', async (filePath) => {
    if (!EXT_RE.test(filePath)) return;
    try { await indexFile(filePath); } catch {}
  });

  activeWatcher.on('unlink', (filePath) => {
    const row = db.prepare('SELECT id FROM images WHERE path = ?').get(filePath);
    if (row) { db.prepare('DELETE FROM images WHERE id = ?').run(row.id); broadcast('images:changed'); }
    console.log(`[watch] -${filePath}`);
  });

  activeWatcher.on('addDir', (dirPath) => {
    ensureFolder(dirPath);
    // Today's folder just appeared — switch from year-level watch to day-level
    if (dirPath === dayFolder) {
      console.log(`[watch] today's folder created, switching`);
      watchDay(dayFolder);
    }
  });

  activeWatcher.on('error', (err) => console.warn('[watch] error:', err.message));

  // Rollover 1 min after midnight so the new day folder has time to be created
  rolloverTimer = setTimeout(() => {
    console.log('[watch] midnight rollover');
    watchDay(getTodayFolder());
  }, msUntilMidnight());
}

export function startWatcher() {
  if (!existsSync(config.imageRoot)) {
    console.warn(`[watch] imageRoot not found: ${config.imageRoot}`);
    return;
  }
  watchDay(getTodayFolder());
}
