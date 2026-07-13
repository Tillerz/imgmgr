import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

const defaults = {
  port: 3000,
  imageRoot: '/mnt/sd/imgmgr',
  thumbnailSize: 220,
  thumbnailQuality: 82,
  cacheDir: '.cache',
  supportedExtensions: ['png', 'webp', 'jpg', 'jpeg'],
  scanOnStart: true,
  watchForChanges: false,
};

let userConfig = {};
try {
  userConfig = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
} catch {}

export const config = { ...defaults, ...userConfig };
