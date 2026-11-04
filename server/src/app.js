import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import pinoHttp from 'pino-http';
import path from 'node:path';
import config from './config.js';
import logger from './lib/logger.js';
import { get } from './db/index.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { globalLimiter, sameOriginOnly, securityHeaders } from './middleware/security.js';
import { authRouter } from './modules/auth/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { chatsRouter } from './modules/chats/routes.js';
import { messagesRouter } from './modules/messages/routes.js';
import { attachmentsRouter } from './modules/attachments/routes.js';

const pkg = JSON.parse(fs.readFileSync(path.join(config.projectRoot, 'package.json'), 'utf8'));

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', 'strong');

  app.use(requestContext);
  app.use(securityHeaders);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      quietReqLogger: true,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url.startsWith('/assets') || req.url.endsWith('.css') || req.url.endsWith('.js') },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug'),
    }),
  );

  app.get('/healthz', async (req, res) => {
    try {
      await get('SELECT 1 AS ok');
      res.json({ status: 'ok', version: pkg.version, uptime: Math.round(process.uptime()), env: config.nodeEnv });
    } catch {
      res.status(503).json({ status: 'degraded' });
    }
  });

  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());
  app.use('/api', sameOriginOnly, globalLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/chats', chatsRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api', messagesRouter);

  app.use('/api', notFoundHandler);

  // Static SPA. Hashed assets get a long cache; the shell never caches.
  app.use(
    express.static(config.publicDir, {
      index: false,
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    }),
  );

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.debug('express app created');
  return app;
}

export default createApp;
