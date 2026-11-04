import http from 'node:http';
import config from './config.js';
import logger from './lib/logger.js';
import { createApp } from './app.js';
import { createRealtime } from './realtime/io.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/index.js';

async function main() {
  await migrate({ quiet: true });

  const app = createApp();
  const server = http.createServer(app);
  const io = createRealtime(server);

  server.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, origin: config.publicOrigin, db: config.dbFile },
      `Speedy is listening on ${config.publicOrigin}`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    io.close();
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
