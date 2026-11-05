import sharp from 'sharp';
import { badRequest } from './errors.js';

const MAX_EDGE = 2560;

/**
 * Re-encode every uploaded image. This is the only reliable way to strip EXIF
 * (GPS, camera serial, timestamps) and to defuse polyglot files - a valid PNG
 * with a PHP payload appended survives a magic-byte check but not a decode and
 * re-encode.
 */
export async function normaliseImage(buffer, mime) {
  try {
    if (mime === 'image/gif') {
      const out = await sharp(buffer, { animated: true, failOn: 'error' }).gif().toBuffer();
      return { buffer: out, mime: 'image/gif' };
    }

    let pipeline = sharp(buffer, { failOn: 'error' }).rotate(); // bakes in EXIF orientation
    const meta = await pipeline.metadata();
    if ((meta.width ?? 0) > MAX_EDGE || (meta.height ?? 0) > MAX_EDGE) {
      pipeline = pipeline.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    }

    if (mime === 'image/png') {
      return { buffer: await pipeline.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' };
    }
    if (mime === 'image/webp') {
      return { buffer: await pipeline.webp({ quality: 90 }).toBuffer(), mime: 'image/webp' };
    }
    return { buffer: await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' };
  } catch {
    // A file that claims to be an image but cannot be decoded is not an image.
    throw badRequest('That image could not be read');
  }
}
