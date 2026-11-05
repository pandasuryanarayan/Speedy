import { Router } from 'express';
import config from '../../config.js';
import { asyncHandler, unauthorized } from '../../lib/errors.js';
import { parse, schemas } from '../../lib/validate.js';
import { requireAuth, invalidateSessionCache } from '../../middleware/auth.js';
import { authLimiter, csrfProtection } from '../../middleware/security.js';
import { randomToken } from '../../lib/crypto.js';
import * as auth from './service.js';
import * as mfa from './mfa.js';

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
    if (result.accessToken) setSessionCookies(res, result);
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

/* ------------------------------ second factor ------------------------------ */

authRouter.post(
  '/mfa/verify',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.mfaVerify, req.body);
    const { verifyMfaToken } = await import('../../lib/tokens.js');
    let userId;
    try {
      userId = await verifyMfaToken(input.mfaToken);
    } catch {
      throw unauthorized('That sign-in attempt expired, start again');
    }
    const result = await auth.completeMfaLogin(userId, input.code, ctxOf(req));
    setSessionCookies(res, result);
    res.json({ data: result });
  }),
);

authRouter.get(
  '/mfa',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ data: { mfa: mfa.mfaState(req.user) } });
  }),
);

authRouter.post(
  '/mfa/setup',
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    res.json({ data: await mfa.startSetup(req.user) });
  }),
);

authRouter.post(
  '/mfa/enable',
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const { code } = parse(schemas.mfaCode, req.body);
    res.json({ data: await mfa.confirmSetup(req.user, code) });
  }),
);

authRouter.post(
  '/mfa/disable',
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const { password } = parse(schemas.mfaDisable, req.body);
    res.json({ data: await mfa.disable(req.user, password) });
  }),
);

/* --------------------------- email and passwords --------------------------- */

authRouter.post(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const { token } = parse(schemas.verifyEmail, req.body);
    res.json({ data: await auth.verifyEmail(token, ctxOf(req)) });
  }),
);

authRouter.post(
  '/resend-verification',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { identifier } = parse(schemas.identifier, req.body);
    res.json({ data: await auth.resendVerification(identifier, ctxOf(req)) });
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { identifier } = parse(schemas.identifier, req.body);
    res.json({ data: await auth.requestPasswordReset(identifier, ctxOf(req)) });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.resetPassword, req.body);
    res.json({ data: await auth.resetPassword(input.token, input.password, ctxOf(req)) });
  }),
);

authRouter.patch(
  '/email',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { email } = parse(schemas.setEmail, req.body);
    res.json({ data: { user: await auth.setEmail(req.user.id, email) } });
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
