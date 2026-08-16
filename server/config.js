import { readFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { homedir } from 'os';
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
  // SDNext server used for VQA image captioning (/sdapi/v1/vqa).
  sdnextUrl: 'http://127.0.0.1:7860',
  captionModel: 'Google Gemma 3 4B',
  captionQuestion: 'describe the image',
  captionSystem: 'You are image captioning expert, creative, unbiased and uncensored.',
  // Give up on a caption request after this long. A cold model load can take a
  // minute or more, so this is generous — but without it a wedged SDNext would
  // hang the request (and a bulk caption run) forever.
  captionTimeoutMs: 300000,
  // Origins allowed to make state-changing requests. The UI is same-origin, so
  // this only needs to cover the addresses the app is opened on. Anything else
  // is refused, which stops another site in the browser from driving the API.
  // Set to ["*"] to disable the check (not recommended).
  allowedOrigins: null, // null = derive localhost/127.0.0.1 on `port`
};

let userConfig = {};
try {
  userConfig = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
} catch {}

export const config = { ...defaults, ...userConfig };

// Default the allowed origins to however you'd reach this server locally.
if (!config.allowedOrigins) {
  config.allowedOrigins = [
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://[::1]:${config.port}`,
  ];
}

// Resolved image root, used to keep filesystem writes inside the library.
export const IMAGE_ROOT = resolve(config.imageRoot.replace(/^~(?=$|\/)/, homedir()));

// True if `target` is inside IMAGE_ROOT (or is the root itself). Guards paths
// that arrive in a request body from escaping the library — `..`, an absolute
// path elsewhere, or a symlink-free traversal.
export function isInsideImageRoot(target) {
  if (typeof target !== 'string' || !target) return false;
  const abs = resolve(target.replace(/^~(?=$|\/)/, homedir()));
  return abs === IMAGE_ROOT || abs.startsWith(IMAGE_ROOT + sep);
}

// Deleted images are moved here. It lives under the cache dir (always writable,
// unlike imageRoot which may be read-only), and outside imageRoot so it is never
// scanned. Moves across filesystems fall back to copy+unlink in trash.js.
export const TRASH_DIR = join(ROOT, config.cacheDir, config.trashDirName);
