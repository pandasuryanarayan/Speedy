import config from '../../config.js';
import { get, run } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { sendMail, isMailConfigured } from '../../lib/mailer.js';
import logger from '../../lib/logger.js';

const TTL = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 };

export async function createEmailToken(userId, kind) {
  const token = randomToken(32);
  await run(
    'INSERT INTO email_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), userId, kind, sha256(token), Date.now() + (TTL[kind] ?? TTL.reset), Date.now()],
  );
  return token;
}

/** Single use: a token is marked used the moment it is accepted. */
export async function consumeEmailToken(token, kind) {
  if (!token) return null;
  const row = await get('SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ?', [sha256(token), kind]);
  if (!row) return null;
  if (row.used_at) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  await run('UPDATE email_tokens SET used_at = ? WHERE id = ?', [Date.now(), row.id]);
  return row.user_id;
}

export async function sendVerificationEmail(user, token) {
  const link = `${config.publicOrigin}/?verify=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: 'Confirm your Speedy email',
    text: `Confirm your email to finish setting up Speedy:\n\n${link}\n\nThis link expires in 24 hours.`,
  });
  if (!isMailConfigured()) logger.warn({ link }, 'verification link (SMTP not configured)');
  return link;
}

export async function sendPasswordResetEmail(user, token) {
  const link = `${config.publicOrigin}/?reset=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your Speedy password',
    text: `Someone asked to reset the password for your Speedy account.\n\n${link}\n\nThis link expires in 1 hour. If this was not you, ignore this email.`,
  });
  if (!isMailConfigured()) logger.warn({ link }, 'reset link (SMTP not configured)');
  return link;
}
