import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

const defaults = {
  port: 3000,
  imageRoot: '~/sd/imgmgr',
  thumbnailSize: 220,
  thumbnailQuality: 82,
  cacheDir: '.cache',
  supportedExtensions: ['png', 'webp', 'jpg', 'jpeg'],
  scanOnStart: true,
  watchForChanges: false,
  trashDirName: 'trash',
};

let userConfig = {};
try {
  userConfig = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
} catch {}

export const config = { ...defaults, ...userConfig };

// Deleted images are moved here. It lives under the cache dir (always writable,
// unlike imageRoot which may be read-only), and outside imageRoot so it is never
// scanned. Moves across filesystems fall back to copy+unlink in trash.js.
export const TRASH_DIR = join(ROOT, config.cacheDir, config.trashDirName);
