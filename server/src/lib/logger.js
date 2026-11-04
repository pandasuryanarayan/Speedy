import { createRequire } from 'node:module';
import pino from 'pino';
import config from '../config.js';

const require = createRequire(import.meta.url);
const prettyAvailable = (() => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

export const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  base: { service: 'speedy' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'token',
      'refreshToken',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
  transport:
    !config.isProd && !config.isTest && prettyAvailable
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

export default logger;
