import { all, get, run } from '../../db/index.js';
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
