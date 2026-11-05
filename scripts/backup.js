#!/usr/bin/env node
/**
 * Online backup: a consistent SQLite snapshot plus the encrypted uploads
 * directory, a manifest, and retention pruning.
 *
 *   node scripts/backup.js [--out <dir>] [--keep <n>]
 *
 * Safe to run while the server is up (VACUUM INTO takes a read transaction and
 * writes a clean copy; it does not touch the live file).
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../server/src/config.js';
import { db, closeDb } from '../server/src/db/index.js';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const sha256File = async (file) => {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
};

export async function runBackup({ out, keep = 7, quiet = false } = {}) {
  const outRoot = path.resolve(out || path.join(config.dataDir, 'backups'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outRoot, stamp);
  await fs.mkdir(dir, { recursive: true });

  const dbTarget = path.join(dir, 'speedy.db');
  await db.execute(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);

  let uploads = 0;
  try {
    await fs.cp(config.uploadDir, path.join(dir, 'uploads'), { recursive: true });
    uploads = (await fs.readdir(path.join(dir, 'uploads'))).length;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const stat = await fs.stat(dbTarget);
  const manifest = {
    createdAt: new Date().toISOString(),
    version: config.nodeEnv,
    database: { file: 'speedy.db', bytes: stat.size, sha256: await sha256File(dbTarget) },
    uploads: { files: uploads },
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // retention: newest `keep` directories survive
  const entries = (await fs.readdir(outRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const stale of entries.slice(keep)) {
    await fs.rm(path.join(outRoot, stale), { recursive: true, force: true });
  }

  if (!quiet) {
    console.log(`backup written: ${dir}`);
    console.log(`  database ${(stat.size / 1024).toFixed(1)} KB, ${uploads} uploads, keeping ${Math.min(keep, entries.length)}`);
  }
  return { dir, manifest };
}

const isMain = process.argv[1] && process.argv[1].endsWith('backup.js');
if (isMain) {
  runBackup({ out: arg('--out'), keep: Number(arg('--keep') || 7) })
    .then(() => closeDb())
    .catch((err) => {
      console.error('backup failed:', err.message);
      process.exitCode = 1;
    });
}
