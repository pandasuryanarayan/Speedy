#!/usr/bin/env node
/**
 * Restore a backup into DATA_DIR.
 *
 *   node scripts/restore.js --from <backup-dir> [--force]
 *
 * Refuses to overwrite an existing database unless --force is given, because
 * that is the one operation you cannot undo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../server/src/config.js';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
};

export async function runRestore({ from, force = false, quiet = false } = {}) {
  if (!from) throw new Error('--from <backup-dir> is required');
  const source = path.resolve(from);
  const manifestPath = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  const dbSource = path.join(source, 'speedy.db');
  const stat = await fs.stat(dbSource);
  if (manifest.database?.bytes && stat.size !== manifest.database.bytes) {
    throw new Error('backup database size does not match its manifest');
  }

  if (!force) {
    const exists = await fs.stat(config.dbFile).then(() => true).catch(() => false);
    if (exists) throw new Error(`${config.dbFile} already exists - pass --force to overwrite`);
  }

  // Clear any WAL sidecars so the restored file is the source of truth.
  for (const suffix of ['-wal', '-shm']) {
    await fs.rm(`${config.dbFile}${suffix}`, { force: true });
  }
  await fs.copyFile(dbSource, config.dbFile);

  const uploadsSource = path.join(source, 'uploads');
  const hasUploads = await fs.stat(uploadsSource).then(() => true).catch(() => false);
  if (hasUploads) {
    await fs.rm(config.uploadDir, { recursive: true, force: true });
    await fs.cp(uploadsSource, config.uploadDir, { recursive: true });
  }

  if (!quiet) console.log(`restored ${manifest.createdAt} backup into ${config.dataDir}`);
  return { manifest };
}

const isMain = process.argv[1] && process.argv[1].endsWith('restore.js');
if (isMain) {
  runRestore({ from: arg('--from'), force: process.argv.includes('--force') }).catch((err) => {
    console.error('restore failed:', err.message);
    process.exitCode = 1;
  });
}
