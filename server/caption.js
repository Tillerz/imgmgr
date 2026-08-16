import sharp from 'sharp';
import { config } from './config.js';

// Ask the SDNext VQA endpoint to caption an image. The image is downscaled to a
// JPEG data-URL before sending to keep the payload small (the VLM re-scales
// internally anyway). Returns the generated caption string, or throws on error.
// sharp's toBuffer() keeps the input container unless a format is requested, so
// the data URL has to name the real type — mislabelling a WebP/PNG as JPEG only
// works while the receiver sniffs the bytes.
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', tiff: 'image/tiff' };

export async function captionImage(imagePath, opts = {}) {
  const img = sharp(imagePath);
  const { format } = await img.metadata();
  const buf = await img
    // .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    // .jpeg({ quality: 88 })
    .toBuffer();
  const dataUrl = `data:${MIME[format] || 'application/octet-stream'};base64,` + buf.toString('base64');

  const body = {
    image: dataUrl,
    model: opts.model || config.captionModel,
    question: opts.question || config.captionQuestion,
    system: opts.system || config.captionSystem,
  };

  const base = config.sdnextUrl.replace(/\/$/, '');
  // Without a deadline a wedged SDNext hangs this request forever, and with it
  // the sequential bulk-caption run in the client.
  const timeout = Number(opts.timeoutMs ?? config.captionTimeoutMs) || 300000;

  let res;
  try {
    res = await fetch(`${base}/sdapi/v1/vqa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`SDNext did not answer within ${Math.round(timeout / 1000)}s (captionTimeoutMs)`);
    }
    throw new Error(`Cannot reach SDNext at ${base}: ${e.message}`);
  }

  // A wrong captionModel is the most likely cause of a failure, but SDNext does
  // not report it as one — an unknown model comes back 200 with an empty answer.
  // So check the name against the server's own list on any failure path.
  const modelHint = async () => {
    const names = await listCaptionModels(base).catch(() => []);
    if (!names.length || names.includes(body.model)) return '';
    return ` — captionModel "${body.model}" is not on this server. Set "captionModel" in config.json to one of: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`;
  };

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SDNext VQA ${res.status}: ${detail.slice(0, 300)}${await modelHint()}`);
  }

  const data = await res.json();
  const caption = (data.answer || '').trim();
  if (!caption) throw new Error(`SDNext VQA returned an empty caption${await modelHint()}`);
  // SDNext reports some internal failures in the answer field itself — a request
  // for an unknown model can leave it returning a bare "error" to the next call.
  // That is 200 OK with a non-empty body, so without this it would be stored as
  // a real caption. Only exact one-word failure tokens are rejected; a genuine
  // caption is a sentence.
  if (/^(error|failed|none|n\/a|null|undefined)[.!]?$/i.test(caption)) {
    throw new Error(
      `SDNext returned "${caption}" instead of a caption. It may be in a bad state — check the SDNext log and retry.${await modelHint()}`
    );
  }
  return caption;
}

// Model names the SDNext server advertises for captioning.
export async function listCaptionModels(base = config.sdnextUrl.replace(/\/$/, '')) {
  const res = await fetch(`${base}/sdapi/v1/vqa/models`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SDNext models ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list.map((m) => m.name).filter(Boolean) : [];
}
