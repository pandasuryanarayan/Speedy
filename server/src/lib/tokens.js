import { SignJWT, jwtVerify } from 'jose';
import config from '../config.js';
import { randomToken, sha256 } from './crypto.js';

const secret = new TextEncoder().encode(config.jwtSecret);

export async function signAccessToken({ userId, sessionId, role = 'user' }) {
  return new SignJWT({ sid: sessionId, role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtl}s`)
    .sign(secret);
}

export async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, secret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    algorithms: ['HS256'],
    clockTolerance: 5,
  });
  if (!payload.sub || !payload.sid) throw new Error('Malformed token');
  return { userId: payload.sub, sessionId: payload.sid, role: payload.role || 'user', exp: payload.exp };
}

/** Refresh tokens are opaque, 384-bit random values; only their SHA-256 is stored. */
export function createRefreshToken() {
  const token = randomToken(48);
  return { token, hash: sha256(token) };
}

export const hashRefreshToken = (token) => sha256(token);

/** 5-minute challenge issued after a correct password when MFA is enabled. */
export async function signMfaToken(userId) {
  return new SignJWT({ purpose: 'mfa' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(config.jwtIssuer)
    .setAudience('speedy-mfa')
    .setIssuedAt()
    .setExpirationTime('300s')
    .sign(secret);
}

export async function verifyMfaToken(token) {
  const { payload } = await jwtVerify(token, secret, {
    issuer: config.jwtIssuer,
    audience: 'speedy-mfa',
    algorithms: ['HS256'],
  });
  if (payload.purpose !== 'mfa' || !payload.sub) throw new Error('Invalid MFA token');
  return payload.sub;
}
