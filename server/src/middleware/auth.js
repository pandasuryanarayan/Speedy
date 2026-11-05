import config from '../config.js';
import { get, run } from '../db/index.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { toUserDTO } from '../lib/dto.js';

const SESSION_CACHE_TTL = 30_000;
const cache = new Map(); // sessionId -> { active, userId, expiresAt }

export function invalidateSessionCache(sessionId) {
  if (sessionId) cache.delete(sessionId);
  else cache.clear();
}

async function loadSession(sessionId) {
  const cached = cache.get(sessionId);
  const now = Date.now();
  if (cached && cached.checkedAt + SESSION_CACHE_TTL > now) return cached;

  const row = await get(
    'SELECT id, user_id, revoked_at, expires_at, last_used_at, family_started_at FROM sessions WHERE id = ?',
    [sessionId],
  );

  const idleExpired = Boolean(row) && now - Number(row.last_used_at ?? now) > config.sessionIdleMs;
  const absoluteExpired = Boolean(row) && now - Number(row.family_started_at ?? row.created_at ?? now) > config.sessionAbsoluteMs;

  if (row && !row.revoked_at && (idleExpired || absoluteExpired)) {
    // Revoke on the spot so the dead session cannot be refreshed later.
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now, sessionId]).catch(() => {});
  }

  const active = Boolean(row) && !row.revoked_at && Number(row.expires_at) > now && !idleExpired && !absoluteExpired;
  if (active) {
    await run('UPDATE sessions SET last_used_at = ? WHERE id = ?', [now, sessionId]).catch(() => {});
  }

  const entry = { active, userId: row?.user_id ?? null, checkedAt: now };
  cache.set(sessionId, entry);
  return entry;
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

/**
 * Verifies the access token AND that its session has not been revoked, so a
 * logout or a detected refresh-token reuse kills access immediately.
 * Returns null instead of throwing, so routes can fall back to other schemes.
 */
export async function authenticateRequest(req) {
  const token = bearerToken(req);
  if (!token) return null;

  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    return null;
  }

  const session = await loadSession(claims.sessionId);
  if (!session.active || session.userId !== claims.userId) return null;

  const user = await get('SELECT * FROM users WHERE id = ?', [claims.userId]);
  if (!user || user.is_disabled) return null;

  return { user, sessionId: claims.sessionId };
}

export async function requireAuth(req, res, next) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) throw unauthorized('Session expired');
    if (auth.user.is_disabled) throw forbidden('This account has been disabled');

    req.user = auth.user;
    req.userDTO = toUserDTO(auth.user, { self: true, viewerId: auth.user.id });
    req.sessionId = auth.sessionId;
    next();
  } catch (err) {
    next(err);
  }
}

export const optionalAuth = (req, res, next) => (bearerToken(req) ? requireAuth(req, res, next) : next());

/** Admin-only routes. Roles are assigned from ADMIN_USERNAMES at boot. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return next(new AppError(403, 'forbidden', 'Administrator access required'));
  }
  next();
}
