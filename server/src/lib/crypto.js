import crypto from 'node:crypto';
import config from '../config.js';

const key = Buffer.from(config.messageKey, 'base64');
if (key.length !== 32) {
  throw new Error('MESSAGE_KEY must decode to exactly 32 bytes (AES-256). Generate one with: openssl rand -base64 32');
}

const PREFIX = 'v1';

/** AES-256-GCM authenticated encryption. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptText(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptText(payload) {
  if (!payload) return null;
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Unsupported ciphertext format');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Binary variant for files: SPV1 | iv(12) | tag(16) | ciphertext.
 * Same AES-256-GCM key as message bodies, so one secret covers the data at rest.
 */
const BLOB_MAGIC = Buffer.from('SPV1');

export function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([BLOB_MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 32 || !payload.subarray(0, 4).equals(BLOB_MAGIC)) {
    throw new Error('Not an encrypted blob');
  }
  const iv = payload.subarray(4, 16);
  const tag = payload.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
}

export const isEncryptedBlob = (payload) =>
  Buffer.isBuffer(payload) && payload.length >= 32 && payload.subarray(0, 4).equals(BLOB_MAGIC);
