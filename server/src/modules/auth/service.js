import config from '../../config.js';
import { get, run, all } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { fakeVerify, hashPassword, verifyPassword } from '../../lib/password.js';
import { createRefreshToken, hashRefreshToken, signAccessToken } from '../../lib/tokens.js';
import { toUserDTO } from '../../lib/dto.js';
import { breachedPasswordCount } from '../../lib/pwned.js';
import { signMfaToken } from '../../lib/tokens.js';
import { consumeEmailToken, createEmailToken, sendPasswordResetEmail, sendVerificationEmail } from './email-tokens.js';
import { verifyLogin as verifyMfaLogin } from './mfa.js';

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'speedy', 'system', 'help', 'api', 'security', 'moderator', 'staff',
]);

function assertUsernameAllowed(username) {
  if (RESERVED_USERNAMES.has(username)) {
    throw conflict('That username is reserved, pick another');
  }
}

async function createSession(userId, { familyId = newId(), familyStartedAt = Date.now(), ip = null, userAgent = null } = {}) {
  const sessionId = newId();
  const { token, hash } = createRefreshToken();
  const now = Date.now();
  await run(
    `INSERT INTO sessions (id, user_id, family_id, token_hash, user_agent, ip, created_at, last_used_at, expires_at, family_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      userId,
      familyId,
      hash,
      (userAgent || '').slice(0, 255),
      ip,
      now,
      now,
      now + config.refreshTokenTtl * 1000,
      familyStartedAt,
    ],
  );
  return { sessionId, refreshToken: token, familyId };
}

async function issueTokens(user, session, { ip, userAgent } = {}) {
  const accessToken = await signAccessToken({ userId: user.id, sessionId: session.sessionId, role: user.role });
  return {
    accessToken,
    refreshToken: session.refreshToken,
    expiresIn: config.accessTokenTtl,
    user: toUserDTO(user, { self: true, viewerId: user.id }),
    sessionId: session.sessionId,
  };
}

export async function register({ username, displayName, password, email }, ctx = {}) {
  if (!config.auth.allowRegistration) {
    throw forbidden('Registration is closed on this instance. Ask an administrator for an account.');
  }
  assertUsernameAllowed(username);

  const existing = await get('SELECT id FROM users WHERE username_lower = ?', [username]);
  if (existing) throw conflict('That username is already taken');

  const normalisedEmail = email ? String(email).trim().toLowerCase() : null;
  if (normalisedEmail) {
    const taken = await get('SELECT id FROM users WHERE email_lower = ?', [normalisedEmail]);
    if (taken) throw conflict('That email is already registered');
  }

  // Refuse passwords that are already in a public breach corpus.
  if (config.security.hibpEnabled) {
    const seen = await breachedPasswordCount(password);
    if (seen > 0) {
      throw unprocessable('That password has appeared in a data breach. Please choose a different one.');
    }
  }

  const now = Date.now();
  const id = newId();
  const passwordHash = await hashPassword(password);
  const needsVerification = Boolean(normalisedEmail) && config.auth.requireEmailVerification;

  await run(
    `INSERT INTO users (id, username, username_lower, display_name, about, password_hash, role, email, email_lower, email_verified_at, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      username,
      username,
      displayName,
      '',
      passwordHash,
      normalisedEmail,
      normalisedEmail,
      needsVerification ? null : now,
      now,
      now,
      now,
    ],
  );

  const user = await get('SELECT * FROM users WHERE id = ?', [id]);
  await audit('auth.register', { userId: id, req: ctx.req });

  if (needsVerification) {
    const token = await createEmailToken(id, 'verify');
    await sendVerificationEmail(user, token);
    return { verificationRequired: true, user: toUserDTO(user, { self: true, viewerId: id }) };
  }

  const session = await createSession(id, ctx);
  return issueTokens(user, session);
}

export async function login({ username, password }, ctx = {}) {
  const user = await get('SELECT * FROM users WHERE username_lower = ?', [username]);

  if (!user) {
    await fakeVerify(password);
    await audit('auth.login_failed', { req: ctx.req, meta: { username, reason: 'unknown_user' } });
    throw unauthorized('Incorrect username or password');
  }

  if (user.locked_until && Number(user.locked_until) > Date.now()) {
    await audit('auth.login_blocked', { userId: user.id, req: ctx.req });
    throw new AppError(423, 'account_locked', 'Too many failed attempts. Try again in a few minutes.');
  }

  if (user.is_disabled) {
    await audit('auth.login_disabled', { userId: user.id, req: ctx.req });
    throw forbidden('This account has been disabled');
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const attempts = Number(user.failed_attempts) + 1;
    const lock = attempts >= config.maxLoginAttempts ? Date.now() + config.lockoutMs : null;
    await run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [lock ? 0 : attempts, lock, user.id]);
    await audit('auth.login_failed', {
      userId: user.id,
      req: ctx.req,
      meta: { attempts, locked: Boolean(lock) },
    });
    throw unauthorized('Incorrect username or password');
  }

  if (config.auth.requireEmailVerification && user.email && !user.email_verified_at) {
    await audit('auth.login_unverified', { userId: user.id, req: ctx.req });
    throw new AppError(403, 'email_unverified', 'Confirm your email address before signing in');
  }

  await run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_seen_at = ? WHERE id = ?', [Date.now(), user.id]);

  // Password is correct, but a second factor is required before a session exists.
  if (user.totp_enabled_at) {
    await audit('auth.mfa_challenge', { userId: user.id, req: ctx.req });
    return { mfaRequired: true, mfaToken: await signMfaToken(user.id) };
  }

  const session = await createSession(user.id, ctx);
  await audit('auth.login', { userId: user.id, req: ctx.req });
  return issueTokens(user, session);
}

/**
 * Refresh-token rotation with reuse detection: if a token that was already
 * rotated is presented again, the whole token family is revoked.
 */
export async function refresh(refreshToken, ctx = {}) {
  if (!refreshToken) throw unauthorized('No session');
  const hash = hashRefreshToken(refreshToken);
  const row = await get('SELECT * FROM sessions WHERE token_hash = ?', [hash]);
  if (!row) throw unauthorized('Session expired, sign in again');

  if (row.revoked_at) {
    await run('UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', [Date.now(), row.family_id]);
    await audit('auth.refresh_reuse', { userId: row.user_id, req: ctx.req, meta: { familyId: row.family_id } });
    throw unauthorized('Session expired, sign in again');
  }

  const now = Date.now();

  if (Number(row.expires_at) <= now) {
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now, row.id]);
    throw unauthorized('Session expired, sign in again');
  }

  // Idle timeout: a session that has not been used recently is dead even if
  // its refresh token is still within its expiry window.
  if (now - Number(row.last_used_at ?? row.created_at) > config.sessionIdleMs) {
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now, row.id]);
    await audit('auth.session_idle_timeout', { userId: row.user_id, req: ctx.req });
    throw unauthorized('Session timed out, sign in again');
  }

  // Absolute lifetime: rotating refresh tokens forever does not extend this.
  if (now - Number(row.family_started_at ?? row.created_at) > config.sessionAbsoluteMs) {
    await run('UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', [now, row.family_id]);
    await audit('auth.session_absolute_timeout', { userId: row.user_id, req: ctx.req });
    throw unauthorized('Session expired, sign in again');
  }

  const user = await get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user || user.is_disabled) throw unauthorized('Session expired, sign in again');

  const next = await createSession(user.id, {
    ...ctx,
    familyId: row.family_id,
    familyStartedAt: Number(row.family_started_at ?? row.created_at),
  });
  await run('UPDATE sessions SET revoked_at = ?, replaced_by = ?, last_used_at = ? WHERE id = ?', [
    Date.now(),
    next.sessionId,
    Date.now(),
    row.id,
  ]);

  return issueTokens(user, next, ctx);
}

export async function logout(sessionId, userId, ctx = {}) {
  await run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?', [Date.now(), sessionId, userId]);
  await audit('auth.logout', { userId, req: ctx.req });
}

export async function logoutAll(userId, ctx = {}) {
  await run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [Date.now(), userId]);
  await audit('auth.logout_all', { userId, req: ctx.req });
}

export async function listSessions(userId, currentSessionId) {
  const rows = await all(
    `SELECT id, user_agent, ip, created_at, last_used_at, expires_at, family_started_at
     FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_used_at DESC`,
    [userId, Date.now()],
  );
  return rows.map((r) => ({
    id: r.id,
    current: r.id === currentSessionId,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    familyStartedAt: r.family_started_at,
  }));
}

export async function revokeSession(userId, sessionId, ctx = {}) {
  const row = await get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
  if (!row) throw notFound('Session not found');
  await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [Date.now(), sessionId]);
  await audit('auth.session_revoked', { userId, req: ctx.req, meta: { sessionId } });
}


/* ------------------------------ second factor ------------------------------ */

export async function completeMfaLogin(userId, code, ctx = {}) {
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || !user.totp_enabled_at) throw unauthorized('Two-factor authentication is not enabled');

  try {
    await verifyMfaLogin(user, code);
  } catch (err) {
    await noteFailedAttempt(user);
    throw unauthorized('That code is not valid');
  }

  await run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_seen_at = ? WHERE id = ?', [Date.now(), user.id]);
  const session = await createSession(user.id, ctx);
  await audit('auth.login', { userId: user.id, req: ctx.req, meta: { mfa: true } });
  return issueTokens(user, session);
}

async function noteFailedAttempt(user) {
  const attempts = Number(user.failed_attempts) + 1;
  const lock = attempts >= config.maxLoginAttempts ? Date.now() + config.lockoutMs : null;
  await run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [lock ? 0 : attempts, lock, user.id]);
}

/* --------------------------- email verification --------------------------- */

export async function verifyEmail(token, ctx = {}) {
  const userId = await consumeEmailToken(token, 'verify');
  if (!userId) throw unauthorized('That confirmation link is invalid or has expired');
  await run('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), userId]);
  await audit('auth.email_verified', { userId, req: ctx.req });
  return { verified: true };
}

export async function resendVerification(identifier, ctx = {}) {
  const user = await get('SELECT * FROM users WHERE username_lower = ? OR email_lower = ?', [identifier, identifier]);
  // Always behave the same, verified or not, existing or not.
  if (user && user.email && !user.email_verified_at) {
    const token = await createEmailToken(user.id, 'verify');
    await sendVerificationEmail(user, token);
    await audit('auth.verification_resent', { userId: user.id, req: ctx.req });
  }
  return { sent: true };
}

/* ------------------------------ password reset ----------------------------- */

export async function requestPasswordReset(identifier, ctx = {}) {
  const user = await get('SELECT * FROM users WHERE username_lower = ? OR email_lower = ?', [identifier, identifier]);
  if (user && user.email) {
    const token = await createEmailToken(user.id, 'reset');
    await sendPasswordResetEmail(user, token);
    await audit('auth.password_reset_requested', { userId: user.id, req: ctx.req });
  }
  // Same answer either way: no account enumeration.
  return { sent: true };
}

export async function resetPassword(token, password, ctx = {}) {
  const userId = await consumeEmailToken(token, 'reset');
  if (!userId) throw unauthorized('That reset link is invalid or has expired');

  if (config.security.hibpEnabled) {
    const seen = await breachedPasswordCount(password);
    if (seen > 0) throw unprocessable('That password has appeared in a data breach. Please choose a different one.');
  }

  await run('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', [
    await hashPassword(password),
    Date.now(),
    userId,
  ]);
  // A password reset invalidates every existing session.
  await run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [Date.now(), userId]);
  await audit('auth.password_reset', { userId, req: ctx.req });
  return { reset: true };
}

/* -------------------------------- profile bits ------------------------------- */

export async function setEmail(userId, email) {
  const normalised = email ? String(email).trim().toLowerCase() : null;
  if (normalised) {
    const taken = await get('SELECT id FROM users WHERE email_lower = ? AND id != ?', [normalised, userId]);
    if (taken) throw conflict('That email is already registered');
  }
  await run('UPDATE users SET email = ?, email_lower = ?, email_verified_at = NULL, updated_at = ? WHERE id = ?', [
    normalised,
    normalised,
    Date.now(),
    userId,
  ]);
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (normalised) {
    const token = await createEmailToken(userId, 'verify');
    await sendVerificationEmail(user, token);
  }
  return toUserDTO(user, { self: true, viewerId: userId });
}
