import config from '../../config.js';
import { get, run, all } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { fakeVerify, hashPassword, verifyPassword } from '../../lib/password.js';
import { createRefreshToken, hashRefreshToken, signAccessToken } from '../../lib/tokens.js';
import { toUserDTO } from '../../lib/dto.js';

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'speedy', 'system', 'help', 'api', 'security', 'moderator', 'staff',
]);

function assertUsernameAllowed(username) {
  if (RESERVED_USERNAMES.has(username)) {
    throw conflict('That username is reserved, pick another');
  }
}

async function createSession(userId, { familyId = newId(), ip = null, userAgent = null } = {}) {
  const sessionId = newId();
  const { token, hash } = createRefreshToken();
  const now = Date.now();
  await run(
    `INSERT INTO sessions (id, user_id, family_id, token_hash, user_agent, ip, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, familyId, hash, (userAgent || '').slice(0, 255), ip, now, now, now + config.refreshTokenTtl * 1000],
  );
  return { sessionId, refreshToken: token, familyId };
}

async function issueTokens(user, session, { ip, userAgent } = {}) {
  const accessToken = await signAccessToken({ userId: user.id, sessionId: session.sessionId, role: user.role });
  return {
    accessToken,
    refreshToken: session.refreshToken,
    expiresIn: config.accessTokenTtl,
    user: toUserDTO(user, { self: true }),
    sessionId: session.sessionId,
  };
}

export async function register({ username, displayName, password }, ctx = {}) {
  assertUsernameAllowed(username);

  const existing = await get('SELECT id FROM users WHERE username_lower = ?', [username]);
  if (existing) throw conflict('That username is already taken');

  const now = Date.now();
  const id = newId();
  const passwordHash = await hashPassword(password);

  await run(
    `INSERT INTO users (id, username, username_lower, display_name, about, password_hash, role, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?)`,
    [id, username, username, displayName, '', passwordHash, now, now, now],
  );

  const user = await get('SELECT * FROM users WHERE id = ?', [id]);
  const session = await createSession(id, ctx);
  await audit('auth.register', { userId: id, req: ctx.req });
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

  await run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_seen_at = ? WHERE id = ?', [Date.now(), user.id]);
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

  if (Number(row.expires_at) <= Date.now()) {
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [Date.now(), row.id]);
    throw unauthorized('Session expired, sign in again');
  }

  const user = await get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user || user.is_disabled) throw unauthorized('Session expired, sign in again');

  const next = await createSession(user.id, { ...ctx, familyId: row.family_id });
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
    'SELECT id, user_agent, ip, created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC',
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
  }));
}

export async function revokeSession(userId, sessionId, ctx = {}) {
  const row = await get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
  if (!row) throw notFound('Session not found');
  await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [Date.now(), sessionId]);
  await audit('auth.session_revoked', { userId, req: ctx.req, meta: { sessionId } });
}
