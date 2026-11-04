/**
 * Upload hardening: never trust the client supplied MIME type or filename.
 * We sniff magic bytes, allow-list the types we serve inline, and force
 * everything else to download with a safe Content-Disposition.
 */
const SIGNATURES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

export const INLINE_SAFE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const match = SIGNATURES.find((sig) => {
    try {
      return sig.test(buffer);
    } catch {
      return false;
    }
  });
  return match ? match.mime : null;
}

/** Strip directories, control chars and reserved characters from an uploaded name. */
export function safeFileName(name, fallback = 'file') {
  const base = String(name || fallback)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .trim()
    .slice(0, 120);
  return base || fallback;
}

export function contentDisposition(filename, inline) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
