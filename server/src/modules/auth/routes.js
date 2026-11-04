import { Router } from 'express';
import config from '../../config.js';
import { asyncHandler } from '../../lib/errors.js';
import { parse, schemas } from '../../lib/validate.js';
import { requireAuth, invalidateSessionCache } from '../../middleware/auth.js';
import { authLimiter, csrfProtection } from '../../middleware/security.js';
import { randomToken } from '../../lib/crypto.js';
import * as auth from './service.js';

export const authRouter = Router();

const isSecureCookie = config.isProd;

function setSessionCookies(res, { refreshToken }) {
  res.cookie(config.cookieName, refreshToken, {
    httpOnly: true,
    secure: isSecureCookie,
    sameSite: 'strict',
    path: config.cookiePath,
    maxAge: config.refreshTokenTtl * 1000,
  });
  // Readable by JS on purpose: this is the double-submit CSRF token, not a secret.
  res.cookie(config.csrfCookieName, randomToken(24), {
    httpOnly: false,
    secure: isSecureCookie,
    sameSite: 'strict',
    path: '/',
    maxAge: config.refreshTokenTtl * 1000,
  });
}

function clearSessionCookies(res) {
  res.clearCookie(config.cookieName, { path: config.cookiePath });
  res.clearCookie(config.csrfCookieName, { path: '/' });
}

const ctxOf = (req) => ({ req, ip: req.ip, userAgent: req.get('user-agent') });

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.register, req.body);
    const result = await auth.register(input, ctxOf(req));
    setSessionCookies(res, result);
    res.status(201).json({ data: result });
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.login, req.body);
    const result = await auth.login(input, ctxOf(req));
    setSessionCookies(res, result);
    res.json({ data: result });
  }),
);

authRouter.post(
  '/refresh',
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await auth.refresh(req.cookies?.[config.cookieName], ctxOf(req));
    setSessionCookies(res, result);
    res.json({ data: result });
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await auth.logout(req.sessionId, req.user.id, ctxOf(req));
    invalidateSessionCache(req.sessionId);
    clearSessionCookies(res);
    res.status(204).end();
  }),
);

authRouter.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    await auth.logoutAll(req.user.id, ctxOf(req));
    invalidateSessionCache();
    clearSessionCookies(res);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ data: { user: req.userDTO } });
  }),
);

authRouter.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ data: { sessions: await auth.listSessions(req.user.id, req.sessionId) } });
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await auth.revokeSession(req.user.id, req.params.id, ctxOf(req));
    invalidateSessionCache(req.params.id);
    res.status(204).end();
  }),
);
