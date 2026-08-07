import sharp from 'sharp';
import { config } from './config.js';

// Ask the SDNext VQA endpoint to caption an image. The image is downscaled to a
// JPEG data-URL before sending to keep the payload small (the VLM re-scales
// internally anyway). Returns the generated caption string, or throws on error.
export async function captionImage(imagePath, opts = {}) {
  const jpg = await sharp(imagePath)
    // .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    // .jpeg({ quality: 88 })
    .toBuffer();
  const dataUrl = 'data:image/jpeg;base64,' + jpg.toString('base64');

  const body = {
    image: dataUrl,
    model: opts.model || config.captionModel,
    question: opts.question || config.captionQuestion,
    system: opts.system || config.captionSystem,
  };

  const url = `${config.sdnextUrl.replace(/\/$/, '')}/sdapi/v1/vqa`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SDNext VQA ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const caption = (data.answer || '').trim();
  if (!caption) throw new Error('SDNext VQA returned an empty caption');
  return caption;
}
