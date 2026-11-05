import crypto from 'node:crypto';
import config from '../config.js';
import { timingSafeEqualString } from './crypto.js';

/**
 * Attachments are served from an authenticated route, but <img>, <video> and
 * download links cannot send an Authorization header. So DTOs carry a
 * short-lived, user-bound signature in the query string:
 *
 *   /api/attachments/<id>?t=<userId>.<expiryMs>.<hmac>
 *
 * The signature is verified with a key derived from JWT_SECRET, the expiry is
 * enforced, and the resolved user still goes through the normal membership
 * check - the token never grants more than that user could already read.
 */
const key = crypto.createHmac('sha256', config.jwtSecret).update('speedy:attachment-url:v1').digest();

export const ATTACHMENT_URL_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const CHAT_UNLOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

function mac(attachmentId, userId, expiresAt) {
  return crypto.createHmac('sha256', key).update(`${attachmentId}.${userId}.${expiresAt}`).digest('base64url');
}

export function signAttachmentUrl(attachmentId, userId, ttlMs = ATTACHMENT_URL_TTL_MS) {
  if (!attachmentId || !userId) return null;
  const expiresAt = Date.now() + ttlMs;
  return `${userId}.${expiresAt}.${mac(attachmentId, userId, expiresAt)}`;
}

/** @returns {{ userId: string } | null} */
export function verifyAttachmentToken(attachmentId, token) {
  if (!attachmentId || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresRaw, signature] = parts;
  const expiresAt = Number(expiresRaw);
  if (!userId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const expected = mac(attachmentId, userId, expiresAt);
  return timingSafeEqualString(signature, expected) ? { userId } : null;
}

/* --------------------------------------------------------------------------
 * Chat unlock tokens. A locked chat returns 423 until the owner re-enters
 * their password; the server then issues a short-lived token bound to that
 * user and chat, so the unlock survives a page refresh but not much longer.
 * ------------------------------------------------------------------------ */
const unlockKey = crypto.createHmac('sha256', config.jwtSecret).update('speedy:chat-unlock:v1').digest();

function unlockMac(chatId, userId, expiresAt) {
  return crypto.createHmac('sha256', unlockKey).update(`${chatId}.${userId}.${expiresAt}`).digest('base64url');
}

export function signChatUnlock(chatId, userId, ttlMs = CHAT_UNLOCK_TTL_MS) {
  const expiresAt = Date.now() + ttlMs;
  return `${expiresAt}.${unlockMac(chatId, userId, expiresAt)}`;
}

export function verifyChatUnlock(chatId, userId, token) {
  if (!chatId || !userId || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expiresRaw, signature] = parts;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return timingSafeEqualString(signature, unlockMac(chatId, userId, expiresAt));
}
