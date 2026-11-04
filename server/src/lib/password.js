import crypto from 'node:crypto';
import config from '../config.js';

const { N, r, p, keylen, maxmem } = config.scrypt;

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Hash a password with scrypt (memory-hard, built into Node - no native build).
 * Format: scrypt$N$r$p$salt$hash  (parameters embedded so they can be upgraded).
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const params = { N, r, p, keylen };
  const key = await scrypt(password, salt, params);
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, n, rr, pp, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, salt, {
      N: Number(n),
      r: Number(rr),
      p: Number(pp),
      keylen: expected.length,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Burn roughly the same CPU as a real verification (defeats user enumeration by timing). */
export async function fakeVerify(password) {
  await scrypt(password || 'x', crypto.randomBytes(16), { N, r, p, keylen });
  return false;
}
