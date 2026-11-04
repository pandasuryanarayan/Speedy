import config from '../config.js';
import logger from '../lib/logger.js';
import { initDb, db, get, closeDb } from './index.js';
import { MIGRATIONS } from './schema.js';

export async function migrate({ quiet = false } = {}) {
  await initDb();
  const row = await get('PRAGMA user_version');
  const current = Number(row?.user_version ?? 0);

  if (current >= MIGRATIONS.length) {
    if (!quiet) logger.info({ version: current }, 'database up to date');
    return current;
  }

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    const t = await db.transaction('write');
    try {
      for (const statement of splitStatements(sql)) {
        await t.execute(statement);
      }
      await t.execute(`PRAGMA user_version = ${version + 1}`);
      await t.commit();
      if (!quiet) logger.info({ version: version + 1 }, 'migration applied');
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }
  return MIGRATIONS.length;
}

/** Split a SQL script on semicolons that are not inside a string literal. */
export function splitStatements(script) {
  const out = [];
  let buf = '';
  let quote = null;
  for (const ch of script) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const isMain = process.argv[1] && process.argv[1].endsWith('migrate.js');
if (isMain) {
  migrate()
    .then((v) => {
      logger.info({ schemaVersion: v, db: config.dbFile }, 'migrations complete');
      return closeDb();
    })
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exitCode = 1;
    });
}
