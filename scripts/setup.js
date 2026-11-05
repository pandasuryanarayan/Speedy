#!/usr/bin/env node
/**
 * Zero-question setup: writes a .env with strong secrets so a clone is
 * runnable in one command. Existing values are preserved.
 *
 *   node scripts/setup.js [--force] [--origin https://chat.example.com]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

const args = process.argv.slice(2);
const force = args.includes('--force');
const originIndex = args.indexOf('--origin');
const origin = originIndex !== -1 ? args[originIndex + 1] : null;

if (fs.existsSync(envPath) && !force) {
  console.log('.env already exists — leaving it alone (use --force to regenerate).');
  process.exit(0);
}

const template = fs.readFileSync(examplePath, 'utf8');
const replacements = {
  JWT_SECRET: crypto.randomBytes(48).toString('base64'),
  MESSAGE_KEY: crypto.randomBytes(32).toString('base64'),
  PUBLIC_ORIGIN: origin || 'http://localhost:3000',
};

const lines = template.split('\n').map((line) => {
  const match = /^([A-Z0-9_]+)=/.exec(line);
  if (!match) return line;
  const key = match[1];
  if (key in replacements) return `${key}=${replacements[key]}`;
  return line;
});

fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
console.log('Wrote .env with generated JWT_SECRET and MESSAGE_KEY.');
console.log('Next:  npm install && npm start   (or: docker compose up -d --build)');
