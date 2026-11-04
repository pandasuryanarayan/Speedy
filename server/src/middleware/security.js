import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import config from '../config.js';
import { AppError, tooManyRequests } from '../lib/errors.js';
import { timingSafeEqualString } from '../lib/crypto.js';

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'manifest-src': ["'self'"],
      ...(config.isProd ? { 'upgrade-insecure-requests': [] } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  frameguard: { action: 'deny' },
  noSniff: true,
  hidePoweredBy: true,
});

/** Same-origin API: no wildcard CORS, and cross-site writes are rejected outright. */
export function sameOriginOnly(req, res, next) {
  const origin = req.get('origin');
  if (origin && origin !== config.publicOrigin) {
    return next(new AppError(403, 'bad_origin', 'Cross-origin request blocked'));
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const secFetchSite = req.get('sec-fetch-site');
    if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) {
      return next(new AppError(403, 'bad_origin', 'Cross-site request blocked'));
    }
  }
  res.set('Cache-Control', 'no-store');
  next();
}

/** Double-submit CSRF token for the cookie-authenticated refresh endpoint. */
export function csrfProtection(req, res, next) {
  const cookie = req.cookies?.[config.csrfCookieName];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !timingSafeEqualString(cookie, header)) {
    return next(new AppError(403, 'csrf_failed', 'Invalid or missing CSRF token'));
  }
  next();
}

const limiterDefaults = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(tooManyRequests()),
};

export const globalLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60_000,
  limit: 300,
});

export const authLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
});

export const writeLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60_000,
  limit: 90,
});

export const uploadLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 60_000,
  limit: 60,
});
