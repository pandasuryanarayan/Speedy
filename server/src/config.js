import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase();
const isProd = nodeEnv === 'production';

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o750 });
  return target;
}

const dataDir = ensureDir(path.resolve(projectRoot, process.env.DATA_DIR || 'data'));
const uploadDir = ensureDir(path.resolve(projectRoot, process.env.UPLOAD_DIR || path.join(dataDir, 'uploads')));

/**
 * Secrets: required in production, auto-generated (and persisted with 0600)
 * in development so `npm start` works on a fresh clone without ceremony.
 */
function loadSecrets() {
  const fromEnv = {
    jwt: process.env.JWT_SECRET?.trim(),
    message: process.env.MESSAGE_KEY?.trim(),
  };

  if (isProd) {
    const problems = [];
    if (!fromEnv.jwt || fromEnv.jwt.length < 32) problems.push('JWT_SECRET (>= 32 chars)');
    if (!fromEnv.message) problems.push('MESSAGE_KEY (base64, 32 bytes)');
    if (problems.length) {
      throw new Error(`Refusing to start in production without: ${problems.join(', ')}`);
    }
    return { jwtSecret: fromEnv.jwt, messageKey: fromEnv.message };
  }

  const file = path.join(dataDir, '.dev-secrets.json');
  const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let dirty = false;

  if (!fromEnv.jwt && !store.jwtSecret) {
    store.jwtSecret = crypto.randomBytes(48).toString('base64url');
    dirty = true;
  }
  if (!fromEnv.message && !store.messageKey) {
    store.messageKey = crypto.randomBytes(32).toString('base64');
    dirty = true;
  }
  if (dirty) fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });

  return {
    jwtSecret: fromEnv.jwt || store.jwtSecret,
    messageKey: fromEnv.message || store.messageKey,
  };
}

const secrets = loadSecrets();

const port = Number.parseInt(process.env.PORT || '3000', 10);
const publicOrigin = (process.env.PUBLIC_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');

export const config = Object.freeze({
  projectRoot,
  nodeEnv,
  isProd,
  isTest: nodeEnv === 'test',
  port,
  publicOrigin,
  dataDir,
  uploadDir,
  dbFile: path.join(dataDir, 'speedy.db'),
  publicDir: path.join(projectRoot, 'public'),

  jwtSecret: secrets.jwtSecret,
  messageKey: secrets.messageKey,
  jwtIssuer: 'speedy',
  jwtAudience: 'speedy-web',
  accessTokenTtl: Number.parseInt(process.env.ACCESS_TOKEN_TTL || '900', 10), // 15 minutes
  refreshTokenTtl: Number.parseInt(process.env.REFRESH_TOKEN_TTL || String(60 * 60 * 24 * 30), 10), // 30 days
  // A session dies after this much inactivity, whatever its expiry says.
  sessionIdleMs: Number.parseInt(process.env.SESSION_IDLE_MINUTES || '30', 10) * 60_000,
  // ...and after this long in total, refresh rotation or not.
  sessionAbsoluteMs: Number.parseInt(process.env.SESSION_ABSOLUTE_DAYS || '30', 10) * 24 * 60 * 60_000,

  trustProxy: process.env.TRUST_PROXY ? Number.parseInt(process.env.TRUST_PROXY, 10) : 0,
  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),

  maxUploadBytes: Number.parseInt(process.env.MAX_UPLOAD_BYTES || String(10 * 1024 * 1024), 10),
  messagePageSize: 40,
  maxMessageLength: 4000,
  maxGroupMembers: 256,

  // Brute-force protection for the login endpoint.
  maxLoginAttempts: 5,
  lockoutMs: 15 * 60 * 1000,
  scrypt: { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 },

  // ---- configurable auth policy -------------------------------------------
  auth: Object.freeze({
    allowRegistration: (process.env.ALLOW_REGISTRATION || 'true') !== 'false',
    requireEmailVerification: (process.env.REQUIRE_EMAIL_VERIFICATION || 'false') === 'true',
    mfaPolicy: ['off', 'optional', 'required'].includes(process.env.MFA_POLICY || '')
      ? process.env.MFA_POLICY
      : 'optional',
    adminUsernames: (process.env.ADMIN_USERNAMES || '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  }),

  smtp: Object.freeze({
    host: process.env.SMTP_HOST || '',
    port: Number.parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Speedy <no-reply@localhost>',
  }),

  security: Object.freeze({
    // Off by default under NODE_ENV=test so the suite never needs the network.
    hibpEnabled: (process.env.HIBP_ENABLED || (nodeEnv === 'test' ? 'false' : 'true')) !== 'false',
    clamavHost: process.env.CLAMAV_HOST || '',
    clamavPort: Number.parseInt(process.env.CLAMAV_PORT || '3310', 10),
    alertWebhook: process.env.ALERT_WEBHOOK_URL || '',
  }),

  redisUrl: process.env.REDIS_URL || '',

  push: Object.freeze({
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@localhost',
  }),

  cookieName: 'speedy_rt',
  csrfCookieName: 'speedy_csrf',
  cookiePath: '/api/auth',
});

export default config;
