import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import { get, run } from '../../db/index.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { sniffMime, safeFileName } from '../../lib/files.js';
import { toAttachmentDTO } from '../../lib/dto.js';

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/octet-stream': 'bin',
};

export async function storeUpload({ userId, file }) {
  if (!file || !file.buffer?.length) throw badRequest('No file received');

  const sniffed = sniffMime(file.buffer);
  const mime = sniffed ?? 'application/octet-stream';
  const originalName = safeFileName(file.originalname);
  const id = newId();
  const storageKey = `${id}.${EXT_BY_MIME[mime] ?? 'bin'}`;
  const target = path.join(config.uploadDir, storageKey);

  // 0600 on disk, random name, stored outside the static root.
  await fs.writeFile(target, file.buffer, { mode: 0o600, flag: 'wx' });

  await run(
    `INSERT INTO attachments (id, owner_id, storage_key, original_name, mime, size, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, storageKey, originalName, mime, file.buffer.length, crypto.createHash('sha256').update(file.buffer).digest('hex'), Date.now()],
  );

  const row = await get('SELECT * FROM attachments WHERE id = ?', [id]);
  return toAttachmentDTO(row);
}

export async function getAttachmentForUser(attachmentId, userId) {
  const row = await get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
  if (!row) throw notFound('Attachment not found');

  const owned = row.owner_id === userId;
  const shared = await get(
    `SELECT 1 AS x FROM messages m
     JOIN chat_members cm ON cm.chat_id = m.chat_id
     WHERE m.attachment_id = ? AND cm.user_id = ? LIMIT 1`,
    [attachmentId, userId],
  );
  const isAvatar = await get(
    'SELECT 1 AS x FROM users WHERE avatar_attachment_id = ? LIMIT 1',
    [attachmentId],
  );

  if (!owned && !shared && !isAvatar) throw forbidden('You do not have access to this file');

  const filePath = path.join(config.uploadDir, row.storage_key);
  // Guard against any path traversal in a corrupted row.
  if (path.dirname(path.resolve(filePath)) !== path.resolve(config.uploadDir)) {
    throw forbidden('Invalid file path');
  }
  return { row, filePath };
}

export async function deleteOrphanUpload(userId, attachmentId) {
  const row = await get('SELECT * FROM attachments WHERE id = ? AND owner_id = ?', [attachmentId, userId]);
  if (!row) throw notFound('Upload not found');
  const used = await get('SELECT 1 AS x FROM messages WHERE attachment_id = ? LIMIT 1', [attachmentId]);
  if (used) throw badRequest('This file is already part of a conversation');
  await run('DELETE FROM attachments WHERE id = ?', [attachmentId]);
  await fs.unlink(path.join(config.uploadDir, row.storage_key)).catch(() => {});
}
