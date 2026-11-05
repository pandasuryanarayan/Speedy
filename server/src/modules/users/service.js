import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import { all, get, run } from '../../db/index.js';
import { decryptText } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { toUserDTO } from '../../lib/dto.js';
import { isOnline } from '../../lib/presence.js';

const PUBLIC_COLUMNS = 'id, username, display_name, about, avatar_attachment_id, last_seen_at, created_at, role';

export async function searchUsers(query, selfId, limit = 10) {
  const needle = query.toLowerCase();
  const rows = await all(
    `SELECT ${PUBLIC_COLUMNS} FROM users
     WHERE id != ? AND is_disabled = 0
       AND (instr(lower(username), ?) > 0 OR instr(lower(display_name), ?) > 0)
       AND id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
     ORDER BY CASE WHEN lower(username) = ? THEN 0 ELSE 1 END, username
     LIMIT ?`,
    [selfId, needle, needle, selfId, needle, limit],
  );
  return rows.map((r) => toUserDTO(r, { viewerId: selfId }));
}

export async function getPublicUser(id, viewerId = null) {
  const row = await get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? AND is_disabled = 0`, [id]);
  if (!row) throw notFound('User not found');
  return toUserDTO(row, { viewerId });
}

export async function updateProfile(userId, { displayName, about }) {
  const fields = [];
  const args = [];
  if (displayName !== undefined) {
    fields.push('display_name = ?');
    args.push(displayName);
  }
  if (about !== undefined) {
    fields.push('about = ?');
    args.push(about ?? '');
  }
  if (!fields.length) throw badRequest('Nothing to update');
  fields.push('updated_at = ?');
  args.push(Date.now(), userId);
  await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, args);
  const row = await get('SELECT * FROM users WHERE id = ?', [userId]);
  return toUserDTO(row, { self: true, viewerId: userId });
}

export async function setAvatar(userId, attachmentId) {
  const attachment = await get('SELECT id FROM attachments WHERE id = ? AND owner_id = ?', [attachmentId, userId]);
  if (!attachment) throw notFound('Upload not found');
  await run('UPDATE users SET avatar_attachment_id = ?, updated_at = ? WHERE id = ?', [attachmentId, Date.now(), userId]);
  const row = await get('SELECT * FROM users WHERE id = ?', [userId]);
  return toUserDTO(row, { self: true, viewerId: userId });
}

export async function blockUser(userId, targetId, req) {
  if (userId === targetId) throw badRequest('You cannot block yourself');
  const target = await get('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target) throw notFound('User not found');
  const existing = await get('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [userId, targetId]);
  if (existing) throw conflict('User already blocked');
  await run('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', [userId, targetId, Date.now()]);
  await audit('user.blocked', { userId, req, meta: { targetId } });
}

export async function unblockUser(userId, targetId) {
  await run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [userId, targetId]);
}

export async function listBlocked(userId) {
  const rows = await all(
    `SELECT u.id, u.username, u.display_name, u.about, u.avatar_attachment_id, u.last_seen_at, b.created_at
     FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...toUserDTO(r, { viewerId: userId }), blockedAt: r.created_at }));
}

export async function isBlockedBetween(a, b) {
  const row = await get(
    'SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
    [a, b, b, a],
  );
  return Boolean(row);
}

export function presenceOf(userId) {
  return { online: isOnline(userId) };
}


/* ------------------------- data portability & erasure ------------------------- */

function safeBody(payload) {
  if (!payload) return null;
  try {
    return decryptText(payload);
  } catch {
    return null;
  }
}

/** Everything we hold about a user, in a shape they can actually read. */
export async function exportUserData(userId) {
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('User not found');

  const memberships = await all(
    `SELECT cm.chat_id, cm.role, cm.joined_at, c.type, c.title
     FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
     WHERE cm.user_id = ? ORDER BY cm.joined_at`,
    [userId],
  );

  const chats = [];
  for (const membership of memberships) {
    const rows = await all(
      `SELECT m.id, m.seq, m.sender_id, m.type, m.body, m.created_at, m.edited_at, m.deleted_at, u.username AS sender_username
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = ? ORDER BY m.seq`,
      [membership.chat_id],
    );
    const members = await all(
      `SELECT u.username, u.display_name FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ?`,
      [membership.chat_id],
    );
    chats.push({
      id: membership.chat_id,
      type: membership.type,
      title: membership.title,
      myRole: membership.role,
      joinedAt: membership.joined_at,
      members: members.map((m) => ({ username: m.username, displayName: m.display_name })),
      messages: rows.map((m) => ({
        id: m.id,
        seq: m.seq,
        sender: m.sender_username ?? null,
        type: m.type,
        body: m.deleted_at ? null : safeBody(m.body),
        createdAt: m.created_at,
        editedAt: m.edited_at,
        deletedAt: m.deleted_at,
      })),
    });
  }

  const attachments = await all(
    'SELECT id, original_name, mime, size, created_at FROM attachments WHERE owner_id = ?',
    [userId],
  );

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      about: user.about,
      createdAt: user.created_at,
      lastSeenAt: user.last_seen_at,
    },
    chats,
    attachments: attachments.map((a) => ({
      id: a.id,
      name: a.original_name,
      mime: a.mime,
      size: a.size,
      createdAt: a.created_at,
    })),
  };
}

/**
 * Right to erasure. Removes the profile, every session, membership, reaction,
 * receipt and uploaded file. Messages the user sent stay in other people's
 * conversations with the sender detached (sender_id is ON DELETE SET NULL), so
 * a conversation is not silently rewritten for everyone else.
 */
export async function deleteAccount(userId, password, req) {
  const user = await get('SELECT password_hash FROM users WHERE id = ?', [userId]);
  const ok = user && password ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) throw new AppError(401, 'bad_password', 'That password is not correct');

  const files = await all('SELECT storage_key FROM attachments WHERE owner_id = ?', [userId]);
  await run('DELETE FROM attachments WHERE owner_id = ?', [userId]);
  for (const file of files) {
    await fs.unlink(path.join(config.uploadDir, file.storage_key)).catch(() => {});
  }

  await run('DELETE FROM users WHERE id = ?', [userId]);
  // Conversations that no longer have any member are meaningless - drop them.
  await run('DELETE FROM chats WHERE id NOT IN (SELECT chat_id FROM chat_members)');

  await audit('account.deleted', { userId, req, meta: { files: files.length } });
  return { deleted: true };
}
