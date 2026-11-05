import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from './errors.js';

/**
 * The only sanctioned way to make an outbound HTTP request.
 *
 * Nothing in Speedy fetches user-supplied URLs today (no link previews), which
 * is exactly why this exists: the moment someone adds one, SSRF is one careless
 * `fetch(url)` away. This guard refuses non-HTTP schemes, credentials in the
 * URL, private/loopback/link-local/metadata addresses (IPv4 and IPv6), DNS
 * names that resolve to them, redirects to them, and unbounded responses.
 */
const BLOCKED_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local + cloud metadata (169.254.169.254)
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^22[4-9]\./, // multicast
  /^2[3-5]\d\./,
];

const BLOCKED_V6 = [/^::1$/, /^::$/, /^f[cd]/i, /^fe80/i, /^ff0/i, /^::ffff:(127|10|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))/i];

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED_V4.some((re) => re.test(address));
  if (family === 6) {
    const normalised = address.toLowerCase();
    return BLOCKED_V6.some((re) => re.test(normalised));
  }
  return true; // not an IP at all - treat as unsafe
}

export async function assertPublicUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'bad_url', 'That is not a valid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError(400, 'bad_url', 'Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new AppError(400, 'bad_url', 'URLs with credentials are not allowed');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new AppError(400, 'blocked_host', 'That address is not reachable');
    return url;
  }

  let records;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new AppError(400, 'bad_url', 'That host could not be resolved');
  }
  if (!records.length) throw new AppError(400, 'bad_url', 'That host could not be resolved');
  // Reject if ANY record points somewhere private - DNS rebinding defence.
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new AppError(400, 'blocked_host', 'That address is not reachable');
  }
  return url;
}

export async function safeFetch(
  rawUrl,
  { timeoutMs = 5000, maxBytes = 512 * 1024, maxRedirects = 3, headers = {}, lookup = dns.lookup } = {},
) {
  let current = await assertPublicUrl(rawUrl, { lookup });

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'Speedy/1.0 (+link-preview)', ...headers },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new AppError(400, 'bad_url', 'Redirect without a location');
        current = await assertPublicUrl(new URL(location, current).toString(), { lookup });
        continue;
      }

      const declared = Number(res.headers.get('content-length') || 0);
      if (declared && declared > maxBytes) throw new AppError(413, 'too_large', 'Response too large');

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxBytes) throw new AppError(413, 'too_large', 'Response too large');
      return { status: res.status, headers: res.headers, body: buffer };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AppError(400, 'too_many_redirects', 'Too many redirects');
}
