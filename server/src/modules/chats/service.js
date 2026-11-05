import { all, get, run, tx } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { decryptText } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { attachmentUrl, toUserDTO } from '../../lib/dto.js';
import { verifyPassword } from '../../lib/password.js';
import { signChatUnlock, verifyChatUnlock } from '../../lib/signed.js';
import { bus, EVENTS } from '../../realtime/bus.js';
import { isBlockedBetween } from '../users/service.js';
import config from '../../config.js';

const USER_COLS = 'u.id, u.username, u.display_name, u.about, u.avatar_attachment_id, u.last_seen_at, u.role';

export async function getChat(chatId) {
  const chat = await get('SELECT * FROM chats WHERE id = ?', [chatId]);
  if (!chat) throw notFound('Chat not found');
  return chat;
}

export async function assertMember(chatId, userId) {
  const member = await get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  if (!member) throw forbidden('You are not a member of this chat');
  return member;
}

export async function memberIds(chatId) {
  const rows = await all('SELECT user_id FROM chat_members WHERE chat_id = ?', [chatId]);
  return rows.map((r) => r.user_id);
}

export async function memberCount(chatId) {
  const row = await get('SELECT COUNT(*) AS c FROM chat_members WHERE chat_id = ?', [chatId]);
  return Number(row?.c ?? 0);
}

export async function directPeer(chatId, userId) {
  const row = await get(
    `SELECT ${USER_COLS} FROM chat_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = ? AND cm.user_id != ? LIMIT 1`,
    [chatId, userId],
  );
  return row ? toUserDTO(row, { viewerId: userId }) : null;
}

function previewOf(chatRow) {
  if (!chatRow?.last_id) return '';
  if (chatRow.last_deleted) return 'This message was deleted';
  if (chatRow.last_type === 'image') return 'Photo';
  if (chatRow.last_type === 'file') return 'Attachment';
  if (chatRow.last_type === 'system') return 'Group created';
  try {
    return (decryptText(chatRow.last_body) || '').slice(0, 120);
  } catch {
    return '';
  }
}

/** Chat list for the sidebar: last message, unread count, member summaries. */
export async function listChats(userId) {
  const chats = await all(
    `SELECT c.id, c.type, c.title, c.avatar_attachment_id, c.seq, c.created_at, c.updated_at,
            cm.role, cm.last_read_seq, cm.last_read_at, cm.muted, cm.pinned, cm.locked,
            lm.id AS last_id, lm.seq AS last_seq, lm.type AS last_type, lm.body AS last_body,
            lm.created_at AS last_at, lm.sender_id AS last_sender, lm.deleted_at AS last_deleted,
            (SELECT COUNT(*) FROM messages m
              WHERE m.chat_id = c.id AND m.seq > cm.last_read_seq
                AND m.sender_id != ? AND m.deleted_at IS NULL) AS unread
     FROM chat_members cm
     JOIN chats c ON c.id = cm.chat_id
     LEFT JOIN messages lm ON lm.id = (SELECT id FROM messages WHERE chat_id = c.id ORDER BY seq DESC LIMIT 1)
     WHERE cm.user_id = ?
     ORDER BY cm.pinned DESC, COALESCE(lm.created_at, c.created_at) DESC`,
    [userId, userId],
  );

  if (!chats.length) return [];

  const ids = chats.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const members = await all(
    `SELECT cm.chat_id, ${USER_COLS} FROM chat_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id IN (${placeholders})`,
    ids,
  );

  const byChat = new Map();
  for (const m of members) {
    if (!byChat.has(m.chat_id)) byChat.set(m.chat_id, []);
    byChat.get(m.chat_id).push(toUserDTO(m, { viewerId: userId }));
  }

  const senderIds = [...new Set(chats.map((c) => c.last_sender).filter(Boolean))];
  const senders = senderIds.length
    ? await all(`SELECT id, display_name FROM users WHERE id IN (${senderIds.map(() => '?').join(',')})`, senderIds)
    : [];
  const senderName = new Map(senders.map((s) => [s.id, s.display_name]));

  return chats.map((c) => {
    const chatMembers = byChat.get(c.id) || [];
    const others = chatMembers.filter((m) => m.id !== userId);
    const peer = c.type === 'direct' ? others[0] ?? null : null;
    return {
      id: c.id,
      type: c.type,
      title: c.type === 'group' ? c.title : peer?.displayName || 'Unknown',
      avatarUrl: c.type === 'group' ? attachmentUrl(c.avatar_attachment_id, userId) : peer?.avatarUrl ?? null,
      peer,
      members: chatMembers,
      role: c.role,
      muted: Boolean(c.muted),
      pinned: Boolean(c.pinned),
      locked: Boolean(c.locked),
      unread: Number(c.unread ?? 0),
      lastReadSeq: Number(c.last_read_seq ?? 0),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      lastMessage: c.locked
        ? null
        : c.last_id
        ? {
            id: c.last_id,
            seq: Number(c.last_seq),
            type: c.last_type,
            preview: previewOf(c),
            createdAt: c.last_at,
            senderId: c.last_sender,
            senderName: c.last_sender === userId ? 'You' : senderName.get(c.last_sender) || 'Unknown',
          }
        : null,
    };
  });
}

export async function getChatDetail(userId, chatId) {
  const chat = await getChat(chatId);
  const member = await assertMember(chatId, userId);
  const rows = await all(
    `SELECT cm.role, cm.joined_at, cm.last_read_seq, cm.muted, cm.pinned, cm.locked, ${USER_COLS}
     FROM chat_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = ? ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`,
    [chatId],
  );
  const members = rows.map((r) => ({ ...toUserDTO(r, { viewerId: userId }), role: r.role, joinedAt: r.joined_at, muted: Boolean(r.muted) }));
  const peer = chat.type === 'direct' ? members.find((m) => m.id !== userId) ?? null : null;

  return {
    id: chat.id,
    type: chat.type,
    title: chat.type === 'group' ? chat.title : peer?.displayName || 'Unknown',
    avatarUrl: chat.type === 'group' ? attachmentUrl(chat.avatar_attachment_id, userId) : peer?.avatarUrl ?? null,
    peer,
    members,
    myRole: member.role,
    muted: Boolean(member.muted),
    pinned: Boolean(member.pinned),
    locked: Boolean(member.locked),
    createdAt: chat.created_at,
  };
}

export async function createDirectChat(userId, otherId) {
  if (userId === otherId) throw badRequest('Pick someone else to chat with');
  const other = await get('SELECT id, display_name FROM users WHERE id = ? AND is_disabled = 0', [otherId]);
  if (!other) throw notFound('User not found');
  if (await isBlockedBetween(userId, otherId)) throw forbidden('You cannot message this user');

  const directKey = [userId, otherId].sort().join(':');
  const existing = await get('SELECT id FROM chats WHERE direct_key = ?', [directKey]);
  if (existing) return getChatDetail(userId, existing.id);

  const chatId = newId();
  const now = Date.now();
  await tx(async (t) => {
    await t.execute({
      sql: 'INSERT INTO chats (id, type, direct_key, created_by, seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      args: [chatId, 'direct', directKey, userId, now, now],
    });
    for (const memberId of [userId, otherId]) {
      await t.execute({
        sql: 'INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        args: [chatId, memberId, 'member', now],
      });
    }
  });

  const detail = await getChatDetail(userId, chatId);
  bus.emit(EVENTS.CHAT_NEW, { chatId, memberIds: [userId, otherId] });
  return detail;
}

export async function createGroupChat(userId, { title, memberIds: requested }) {
  const unique = [...new Set(requested.filter((id) => id !== userId))];
  if (!unique.length) throw badRequest('Add at least one other member');
  if (unique.length + 1 > config.maxGroupMembers) throw badRequest('Group is too large');

  const placeholders = unique.map(() => '?').join(',');
  const found = await all(`SELECT id FROM users WHERE id IN (${placeholders}) AND is_disabled = 0`, unique);
  if (found.length !== unique.length) throw badRequest('Some members could not be found');

  const chatId = newId();
  const now = Date.now();
  await tx(async (t) => {
    await t.execute({
      sql: 'INSERT INTO chats (id, type, title, created_by, seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      args: [chatId, 'group', title, userId, now, now],
    });
    await t.execute({
      sql: 'INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      args: [chatId, userId, 'owner', now],
    });
    for (const id of unique) {
      await t.execute({
        sql: 'INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        args: [chatId, id, 'member', now],
      });
    }
    await t.execute({
      sql: `INSERT INTO messages (id, chat_id, seq, sender_id, type, body, created_at)
            VALUES (?, ?, 1, NULL, 'system', NULL, ?)`,
      args: [newId(), chatId, now],
    });
    await t.execute({ sql: 'UPDATE chats SET seq = 1 WHERE id = ?', args: [chatId] });
  });

  await audit('chat.group_created', { userId, meta: { chatId, size: unique.length + 1 } });
  const detail = await getChatDetail(userId, chatId);
  bus.emit(EVENTS.CHAT_NEW, { chatId, memberIds: [userId, ...unique] });
  return detail;
}

async function requireAdmin(chatId, userId) {
  const member = await assertMember(chatId, userId);
  if (!['owner', 'admin'].includes(member.role)) throw forbidden('Only group admins can do that');
  return member;
}

export async function updateChat(userId, chatId, { title }) {
  const chat = await getChat(chatId);
  if (chat.type !== 'group') throw badRequest('Only groups can be renamed');
  await requireAdmin(chatId, userId);
  await run('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?', [title, Date.now(), chatId]);
  const members = await memberIds(chatId);
  bus.emit(EVENTS.CHAT_UPDATED, { chatId, memberIds: members });
  return getChatDetail(userId, chatId);
}

export async function addMembers(userId, chatId, requested) {
  const chat = await getChat(chatId);
  if (chat.type !== 'group') throw badRequest('Only groups have members');
  await requireAdmin(chatId, userId);

  const current = await memberIds(chatId);
  const unique = [...new Set(requested)].filter((id) => !current.includes(id));
  if (!unique.length) throw conflict('Those people are already in the group');
  if (current.length + unique.length > config.maxGroupMembers) throw badRequest('Group is too large');

  const placeholders = unique.map(() => '?').join(',');
  const found = await all(`SELECT id FROM users WHERE id IN (${placeholders}) AND is_disabled = 0`, unique);
  if (found.length !== unique.length) throw badRequest('Some members could not be found');

  const now = Date.now();
  for (const id of unique) {
    await run('INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [
      chatId, id, 'member', now,
    ]);
  }
  await audit('chat.members_added', { userId, meta: { chatId, count: unique.length } });
  bus.emit(EVENTS.CHAT_UPDATED, { chatId, memberIds: [...current, ...unique] });
  return getChatDetail(userId, chatId);
}

export async function removeMember(userId, chatId, targetId) {
  const chat = await getChat(chatId);
  if (chat.type !== 'group') throw badRequest('Only groups have members');
  const me = await requireAdmin(chatId, userId);
  if (targetId === userId) return leaveChat(userId, chatId);

  const target = await get('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, targetId]);
  if (!target) throw notFound('That person is not in this group');
  if (target.role === 'owner') throw forbidden('The group owner cannot be removed');

  await run('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, targetId]);
  await audit('chat.member_removed', { userId, meta: { chatId, targetId, by: me.role } });
  const members = await memberIds(chatId);
  bus.emit(EVENTS.CHAT_UPDATED, { chatId, memberIds: [...members, targetId] });
  return getChatDetail(userId, chatId);
}

export async function setRole(userId, chatId, targetId, role) {
  const chat = await getChat(chatId);
  if (chat.type !== 'group') throw badRequest('Only groups have roles');
  const me = await assertMember(chatId, userId);
  if (me.role !== 'owner') throw forbidden('Only the group owner can change roles');
  if (!['admin', 'member'].includes(role)) throw badRequest('Invalid role');

  const target = await get('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, targetId]);
  if (!target) throw notFound('That person is not in this group');
  if (target.role === 'owner') throw forbidden('The owner role cannot be changed');

  await run('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?', [role, chatId, targetId]);
  const members = await memberIds(chatId);
  bus.emit(EVENTS.CHAT_UPDATED, { chatId, memberIds: members });
  return getChatDetail(userId, chatId);
}

export async function leaveChat(userId, chatId) {
  const chat = await getChat(chatId);
  const member = await assertMember(chatId, userId);

  if (chat.type === 'direct') {
    await run('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    const remaining = await memberCount(chatId);
    if (remaining === 0) {
      await run('DELETE FROM chats WHERE id = ?', [chatId]);
    }
    return { left: true, chatDeleted: remaining === 0 };
  }

  await run('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  if (member.role === 'owner') {
    const next = await get(
      "SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1",
      [chatId],
    );
    if (next) await run("UPDATE chat_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?", [chatId, next.user_id]);
  }
  const members = await memberIds(chatId);
  if (!members.length) await run('DELETE FROM chats WHERE id = ?', [chatId]);
  else bus.emit(EVENTS.CHAT_UPDATED, { chatId, memberIds: [...members, userId] });
  return { left: true };
}

export async function setMuted(userId, chatId, muted) {
  await assertMember(chatId, userId);
  await run('UPDATE chat_members SET muted = ? WHERE chat_id = ? AND user_id = ?', [muted ? 1 : 0, chatId, userId]);
  return { muted: Boolean(muted) };
}

/** Pinning is personal to the member, so it never touches the chat itself. */
export async function setPinned(userId, chatId, pinned) {
  await assertMember(chatId, userId);
  await run('UPDATE chat_members SET pinned = ? WHERE chat_id = ? AND user_id = ?', [pinned ? 1 : 0, chatId, userId]);
  return { pinned: Boolean(pinned) };
}

async function assertPassword(userId, password) {
  const user = await get('SELECT password_hash FROM users WHERE id = ?', [userId]);
  const ok = user && password ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) throw new AppError(401, 'bad_password', 'That password is not correct');
}

/**
 * Locking hides the conversation behind the account password. The `locked`
 * flag stays set while unlocked - the token returned by unlockChat() is what
 * grants temporary access, so closing the tab re-locks the chat.
 */
export async function setLocked(userId, chatId, { locked, password }) {
  await assertMember(chatId, userId);

  if (locked) {
    await run('UPDATE chat_members SET locked = 1 WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    await audit('chat.locked', { userId, meta: { chatId } });
    return { locked: true };
  }

  await assertPassword(userId, password);
  await run('UPDATE chat_members SET locked = 0 WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  await audit('chat.unlocked_permanently', { userId, meta: { chatId } });
  return { locked: false };
}

export async function unlockChat(userId, chatId, { password }) {
  const member = await assertMember(chatId, userId);
  if (!member.locked) return { locked: false, unlockToken: null };

  await assertPassword(userId, password);
  await audit('chat.unlocked', { userId, meta: { chatId } });
  return { locked: true, unlockToken: signChatUnlock(chatId, userId) };
}

/** Throws 423 when a chat is locked and the caller has no valid unlock token. */
export function assertUnlocked(member, chatId, userId, unlockToken) {
  if (!member.locked) return;
  if (verifyChatUnlock(chatId, userId, unlockToken)) return;
  throw new AppError(423, 'chat_locked', 'This chat is locked. Enter your password to open it.');
}
