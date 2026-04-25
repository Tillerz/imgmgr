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

// Perceptual hash: resize to 8x8 grayscale, compare adjacent pixels
export async function computePHash(imagePath) {
  try {
    const { data } = await sharp(imagePath)
      .resize(9, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        bits += data[row * 9 + col] < data[row * 9 + col + 1] ? '1' : '0';
      }
    }
    return parseInt(bits, 2).toString(16).padStart(16, '0');
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
