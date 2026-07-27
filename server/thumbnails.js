import sharp from 'sharp';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config, ROOT } from './config.js';

const thumbDir = join(ROOT, config.cacheDir, 'thumbs');

export function thumbPath(fileHash) {
  return join(thumbDir, `${fileHash}.webp`);
}

export async function ensureThumbnail(imagePath, fileHash) {
  const dest = thumbPath(fileHash);
  if (existsSync(dest)) return dest;
  await sharp(imagePath)
    .resize(config.thumbnailSize, config.thumbnailSize, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: config.thumbnailQuality })
    .toFile(dest);
  return dest;
}

export async function getImageInfo(imagePath) {
  const meta = await sharp(imagePath).metadata();
  return { width: meta.width || 0, height: meta.height || 0, format: meta.format || '' };
}

export async function computeFileHash(imagePath) {
  const buf = readFileSync(imagePath);
  return createHash('md5').update(buf).digest('hex');
}

// 1-D DCT-II (naive O(n^2) — n is only 32, so this is plenty fast).
function dct1d(vec) {
  const N = vec.length;
  const out = new Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) sum += vec[n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
    out[k] = sum;
  }
  return out;
}

// Perceptual hash (DCT-based pHash, 64-bit). Resize to 32x32 greyscale, run a
// separable 2-D DCT, keep the low-frequency top-left 8x8 block, and threshold
// each coefficient against the block's median. Keying on the coarse frequency
// structure (rather than raw adjacent pixels, as a dHash does) makes it robust
// to the fine-detail differences between e.g. two seeds of the same prompt, so
// genuinely similar images sit far below the noise floor of unrelated ones.
// PHASH_VERSION is bumped whenever this algorithm changes, to trigger a recompute.
export const PHASH_VERSION = 2;
export async function computePHash(imagePath) {
  try {
    const N = 32;
    const { data } = await sharp(imagePath)
      .resize(N, N, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Separable 2-D DCT: transform every row, then every column.
    const m = [];
    for (let r = 0; r < N; r++) {
      const row = new Array(N);
      for (let c = 0; c < N; c++) row[c] = data[r * N + c];
      m.push(dct1d(row));
    }
    for (let c = 0; c < N; c++) {
      const col = dct1d(m.map((row) => row[c]));
      for (let r = 0; r < N; r++) m[r][c] = col[r];
    }
    // Low-frequency 8x8 block; median over the AC terms (excludes the huge DC
    // term at [0,0], which would otherwise skew the threshold).
    const block = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) block.push(m[r][c]);
    const ac = block.slice(1).sort((a, b) => a - b);
    const median = ac[ac.length >> 1];
    let bits = '';
    for (let i = 0; i < 64; i++) bits += block[i] > median ? '1' : '0';
    return BigInt('0b' + bits).toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dist = 0;
  const ai = BigInt(`0x${a}`);
  const bi = BigInt(`0x${b}`);
  let xor = ai ^ bi;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}
