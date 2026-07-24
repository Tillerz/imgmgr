import { readFile } from 'fs/promises';
import exifr from 'exifr';
import exifReader from 'exif-reader';

// Read PNG tEXt and iTXt chunks directly from buffer
function parsePNGTextChunks(buf) {
  const chunks = {};
  if (buf.length < 8) return chunks;
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IEND') break;
    if (type === 'tEXt' && offset + 8 + length <= buf.length) {
      const data = buf.subarray(offset + 8, offset + 8 + length);
      const nul = data.indexOf(0);
      if (nul !== -1) {
        chunks[data.toString('latin1', 0, nul)] = data.toString('utf8', nul + 1);
      }
    } else if (type === 'iTXt' && offset + 8 + length <= buf.length) {
      const data = buf.subarray(offset + 8, offset + 8 + length);
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const keyword = data.toString('ascii', 0, nul);
        let pos = nul + 3; // skip compression_flag + compression_method
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++;
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++;
        if (pos < data.length) chunks[keyword] = data.toString('utf8', pos);
      }
    }
    offset += 12 + length;
  }
  return chunks;
}

// Extract named chunks from a WebP RIFF container
function extractWebPChunks(buf) {
  const chunks = {};
  if (buf.length < 12) return chunks;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return chunks;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return chunks;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (offset + 8 + size > buf.length) break;
    chunks[type] = buf.slice(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1); // chunks are word-aligned
  }
  return chunks;
}

// Decode an EXIF UserComment buffer (charset in first 8 bytes, then encoded text)
function decodeUserComment(raw, bigEndian = false) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.data ?? raw);
  const charset = buf.slice(0, 8).toString('ascii').replace(/\0/g, '').trim().toUpperCase();
  const text = buf.slice(8);
  if (charset === 'UNICODE') {
    if (bigEndian) {
      // UTF-16 BE — swap byte pairs to convert to LE for Node
      const swapped = Buffer.allocUnsafe(text.length & ~1);
      for (let i = 0; i < swapped.length; i += 2) {
        swapped[i]     = text[i + 1];
        swapped[i + 1] = text[i];
      }
      return swapped.toString('utf16le').replace(/\0/g, '');
    }
    return text.toString('utf16le').replace(/\0/g, '');
  }
  // ASCII or fallback UTF-8
  return text.toString('utf8').replace(/\0/g, '');
}

// Flatten exif-reader's nested IFD objects into a single key/value map
function flattenExifReader(parsed) {
  const out = {};
  for (const ifd of ['Image', 'Photo', 'GPSInfo', 'Iop', 'Thumbnail']) {
    if (!parsed[ifd]) continue;
    for (const [k, v] of Object.entries(parsed[ifd])) {
      if (k === 'UserComment') continue; // handled separately
      if (v == null) continue;
      const str = (v?.type === 'Buffer' || Buffer.isBuffer(v))
        ? Buffer.from(v.data ?? v).toString('utf8').replace(/\0/g, '')
        : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      if (str.length > 0 && str.length < 4096) out[k] = str;
    }
  }
  return out;
}

// Parse SD-style "parameters" string: positive\nNegative prompt: negative\nSteps: ...
export function parseSDParameters(raw) {
  if (!raw) return { positive: '', negative: '' };
  const negMarker = '\nNegative prompt: ';
  const negIdx = raw.indexOf(negMarker);
  if (negIdx === -1) {
    return { positive: raw.trim(), negative: '' };
  }
  const positive = raw.slice(0, negIdx).trim();
  const afterNeg = raw.slice(negIdx + negMarker.length);
  const paramLine = afterNeg.search(/\n\s*Steps\s*:/i);
  const negative = paramLine === -1 ? afterNeg.trim() : afterNeg.slice(0, paramLine).trim();
  return { positive, negative };
}

// Discrete generation parameters we pull out of the SD params line for faceting.
export const GEN_PARAM_KEYS = [
  'Model', 'Sampler', 'Steps', 'CFG scale', 'Schedule type',
  'Model hash', 'VAE', 'Clip skip', 'Size', 'Denoising strength',
];

// Parse the trailing "Steps: 20, Sampler: Euler a, CFG scale: 7, Model: ..."
// line of an SD parameters/UserComment string into discrete key/value pairs.
// Values may contain commas, so we split only at ", <Key>:" boundaries.
export function parseGenerationParams(full) {
  if (!full) return {};
  const idx = full.search(/\bSteps:\s/);
  if (idx === -1) return {};
  const tail = full.slice(idx).replace(/\s+/g, ' ').trim();
  const out = {};
  const re = /([A-Za-z][A-Za-z0-9 ]*?):\s*(.*?)(?=,\s*[A-Za-z][A-Za-z0-9 ]*?:\s|$)/g;
  let m;
  while ((m = re.exec(tail)) !== null) {
    const key = m[1].trim();
    const val = m[2].trim().replace(/,+$/, '').trim();
    if (key && val) out[key] = val;
  }
  return out;
}

// Parse an EXIF/TIFF buffer with exif-reader and populate result.raw plus the
// SD prompts carried in UserComment. Shared by the WebP and JPEG paths.
function applyExifBuffer(exifBuf, result) {
  const parsed = exifReader(exifBuf);
  result.raw = flattenExifReader(parsed);
  const uc = parsed.Photo?.UserComment;
  if (uc) {
    const text = decodeUserComment(uc, parsed.bigEndian);
    if (text) {
      result.raw['UserComment'] = text;
      const { positive, negative } = parseSDParameters(text);
      result.positive_prompt = positive;
      result.negative_prompt = negative;
    }
  }
}

export async function extractMetadata(filePath) {
  const result = { positive_prompt: '', negative_prompt: '', raw: {} };
  try {
    const isWebP = /\.webp$/i.test(filePath);
    const isPNG  = /\.png$/i.test(filePath);
    const isJPEG = /\.jpe?g$/i.test(filePath);
    const buf = await readFile(filePath);

    if (isWebP) {
      // exifr doesn't support this WebP variant; parse the RIFF container directly
      const chunks = extractWebPChunks(buf);
      if (chunks['EXIF']) {
        try { applyExifBuffer(chunks['EXIF'], result); } catch {}
      }
    } else if (isJPEG) {
      // SD tools write parameters into the EXIF UserComment (same as WebP).
      // Locate the APP1 "Exif\0\0" header and hand the TIFF block to exif-reader.
      const marker = buf.indexOf(Buffer.from('Exif\0\0', 'latin1'));
      if (marker !== -1) {
        try { applyExifBuffer(buf.slice(marker + 6), result); } catch {}
      }
    } else {
      // PNG: use exifr + manual tEXt chunk reading
      let exifrData = {};
      try {
        exifrData = await exifr.parse(filePath, {
          tiff: true, exif: true, gps: true, iptc: true,
          icc: false, jfif: false, sanitize: false, mergeOutput: true,
        }) || {};
      } catch {}

      if (isPNG) {
        try {
          Object.assign(exifrData, parsePNGTextChunks(buf));
        } catch {}
      }

      result.raw = exifrData;

      const paramSources = ['parameters', 'Parameters', 'sd-metadata', 'prompt', 'UserComment'];
      for (const key of paramSources) {
        const val = exifrData[key];
        if (val && typeof val === 'string' && val.length > 0) {
          const { positive, negative } = parseSDParameters(val);
          result.positive_prompt = positive;
          result.negative_prompt = negative;
          break;
        }
      }
    }

    // Extract discrete generation params (Model, Sampler, …) from whichever
    // source string carries them, so they get stored as facetable metadata rows.
    const sdSource = result.raw?.UserComment || result.raw?.parameters || result.raw?.Parameters || '';
    if (typeof sdSource === 'string' && sdSource) {
      const gp = parseGenerationParams(sdSource);
      for (const k of GEN_PARAM_KEYS) {
        if (gp[k] != null && gp[k] !== '') result.raw[k] = gp[k];
      }
    }
  } catch {
    // non-fatal
  }
  return result;
}
