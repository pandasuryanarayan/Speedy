import { get, run } from '../../db/index.js';
import config from '../../config.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { generateBackupCodes, generateSecret, hashBackupCode, keyUri, verifyToken } from '../../lib/totp.js';
import { audit } from '../../lib/audit.js';

const parseCodes = (raw) => {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
};

export async function startSetup(user) {
  if (config.auth.mfaPolicy === 'off') throw forbidden('Two-factor authentication is disabled on this instance');
  if (user.totp_enabled_at) throw badRequest('Two-factor authentication is already enabled');

  const secret = generateSecret();
  await run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, user.id]);
  return { secret, uri: keyUri({ secret, account: user.username }) };
}

export async function confirmSetup(user, code) {
  if (!user.totp_secret) throw badRequest('Start the setup first');
  if (!verifyToken(user.totp_secret, code)) throw badRequest('That code is not correct, try the next one');

  const codes = generateBackupCodes();
  await run('UPDATE users SET totp_enabled_at = ?, backup_codes = ? WHERE id = ?', [
    Date.now(),
    JSON.stringify(codes.map(hashBackupCode)),
    user.id,
  ]);
  await audit('auth.mfa_enabled', { userId: user.id });
  return { enabled: true, backupCodes: codes };
}

export async function disable(user, password) {
  const ok = password ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) throw badRequest('That password is not correct');
  await run('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, backup_codes = NULL WHERE id = ?', [user.id]);
  await audit('auth.mfa_disabled', { userId: user.id });
  return { enabled: false };
}

/** Accepts a TOTP code or one of the single-use backup codes. */
export async function verifyLogin(user, code) {
  const clean = String(code || '').trim();
  if (!clean) throw badRequest('Enter your authentication code');

  if (verifyToken(user.totp_secret, clean)) return true;

  const hashes = parseCodes(user.backup_codes);
  const hash = hashBackupCode(clean);
  const index = hashes.indexOf(hash);
  if (index !== -1) {
    hashes.splice(index, 1); // single use
    await run('UPDATE users SET backup_codes = ? WHERE id = ?', [JSON.stringify(hashes), user.id]);
    await audit('auth.mfa_backup_code_used', { userId: user.id });
    return true;
  }

  throw notFound('That code is not valid');
}

export const mfaState = (user) => ({
  enabled: Boolean(user.totp_enabled_at),
  policy: config.auth.mfaPolicy,
  backupCodesRemaining: parseCodes(user.backup_codes).length,
});

export async function userWithSecret(userId) {
  return get('SELECT * FROM users WHERE id = ?', [userId]);
}
