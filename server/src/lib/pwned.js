import crypto from 'node:crypto';
import config from '../config.js';
import logger from './logger.js';

/**
 * Breached-password screening via Have I Been Pwned's k-anonymity range API:
 * only the first five characters of the SHA-1 leave the server, never the
 * password or the full hash. Fails open (with a log line) so an outage at HIBP
 * never locks people out of registration.
 */
export async function breachedPasswordCount(password) {
  if (!config.security.hibpEnabled) return 0;

  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'user-agent': 'Speedy/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HIBP responded ${res.status}`);
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':');
      if (hashSuffix === suffix) return Number.parseInt(count, 10) || 0;
    }
    return 0;
  } catch (err) {
    logger.warn({ err: err.message }, 'breach check unavailable - allowing password');
    return 0;
  } finally {
    clearTimeout(timer);
  }
}
