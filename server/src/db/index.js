import { createClient } from '@libsql/client';
import config from '../config.js';
import logger from '../lib/logger.js';

export const db = createClient({
  url: `file:${config.dbFile}`,
  intMode: 'number',
});

let ready = null;

/** Configure the connection once (WAL, foreign keys, busy timeout). */
export function initDb() {
  if (!ready) {
    ready = (async () => {
      await db.execute('PRAGMA journal_mode = WAL');
      await db.execute('PRAGMA foreign_keys = ON');
      await db.execute('PRAGMA busy_timeout = 5000');
      await db.execute('PRAGMA synchronous = NORMAL');
      logger.debug({ file: config.dbFile }, 'sqlite ready');
    })();
  }
  return ready;
}

const norm = (args = []) =>
  args.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return Number(v);
    return v;
  });

export async function all(sql, args = []) {
  const res = await db.execute({ sql, args: norm(args) });
  return res.rows;
}

export async function get(sql, args = []) {
  const res = await db.execute({ sql, args: norm(args) });
  return res.rows[0] ?? null;
}

export async function run(sql, args = []) {
  const res = await db.execute({ sql, args: norm(args) });
  return { changes: res.rowsAffected, lastId: Number(res.lastInsertRowid ?? 0) };
}

/** Run `fn` inside a write transaction; rolls back on throw. */
export async function tx(fn) {
  const t = await db.transaction('write');
  try {
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    try {
      await t.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export async function closeDb() {
  db.close();
}

export default { db, initDb, all, get, run, tx, closeDb };
