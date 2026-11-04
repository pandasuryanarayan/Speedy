import { get } from '../db/index.js';
import { forbidden, unauthorized } from '../lib/errors.js';
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

  const row = await get('SELECT id, user_id, revoked_at, expires_at FROM sessions WHERE id = ?', [sessionId]);
  const entry = {
    active: Boolean(row) && !row.revoked_at && Number(row.expires_at) > now,
    userId: row?.user_id ?? null,
    checkedAt: now,
  };
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
 */
export async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw unauthorized('Missing access token');

    let claims;
    try {
      claims = await verifyAccessToken(token);
    } catch {
      throw unauthorized('Session expired');
    }

    const session = await loadSession(claims.sessionId);
    if (!session.active || session.userId !== claims.userId) throw unauthorized('Session expired');

    const user = await get('SELECT * FROM users WHERE id = ?', [claims.userId]);
    if (!user) throw unauthorized('Session expired');
    if (user.is_disabled) throw forbidden('This account has been disabled');

    req.user = user;
    req.userDTO = toUserDTO(user, { self: true });
    req.sessionId = claims.sessionId;
    next();
  } catch (err) {
    next(err);
  }
}

export const optionalAuth = (req, res, next) => (bearerToken(req) ? requireAuth(req, res, next) : next());
