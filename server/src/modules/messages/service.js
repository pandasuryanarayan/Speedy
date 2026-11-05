import { all, get, run, tx } from '../../db/index.js';
import config from '../../config.js';
import { decryptText, encryptText } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { toAttachmentDTO, toMessageDTO } from '../../lib/dto.js';
import { isOnline } from '../../lib/presence.js';
import { bus, EVENTS } from '../../realtime/bus.js';
import { assertMember, assertUnlocked, directPeer, getChat, memberCount, memberIds } from '../chats/service.js';
import { isBlockedBetween } from '../users/service.js';

const MAX_BODY = config.maxMessageLength;

function replyPreview(row, senderName) {
  if (!row) return null;
  const base = { id: row.id, senderName: senderName || 'Unknown', type: row.type };
  if (row.deleted_at) return { ...base, preview: 'This message was deleted' };
  if (row.type === 'image') return { ...base, preview: 'Photo' };
  if (row.type === 'file') return { ...base, preview: 'Attachment' };
  if (row.type === 'system') return { ...base, preview: row.seq === 1 ? 'Group created' : 'System message' };
  let text = '';
  try {
    text = decryptText(row.body) || '';
  } catch {
    text = '';
  }
  return { ...base, preview: text.slice(0, 140) };
}

/** Turn raw message rows into client-ready DTOs in a fixed number of queries. */
async function hydrate(rows, viewerId, chatId) {
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const senderIds = [...new Set(rows.map((r) => r.sender_id).filter(Boolean))];
  const attachmentIds = [...new Set(rows.map((r) => r.attachment_id).filter(Boolean))];
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];

  const [senders, attachments, reactions, receipts, replies, mentionRows, total] = await Promise.all([
    senderIds.length
      ? all(
          `SELECT id, username, display_name, avatar_attachment_id FROM users WHERE id IN (${senderIds.map(() => '?').join(',')})`,
          senderIds,
        )
      : [],
    attachmentIds.length
      ? all(`SELECT * FROM attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})`, attachmentIds)
      : [],
    all(
      `SELECT message_id, emoji, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE message_id IN (${ph}) GROUP BY message_id, emoji`,
      [viewerId, ...ids],
    ),
    all(
      `SELECT message_id, user_id, delivered_at, read_at FROM message_receipts WHERE message_id IN (${ph})`,
      ids,
    ),
    replyIds.length
      ? all(
          `SELECT m.id, m.type, m.body, m.deleted_at, m.seq, u.display_name AS sender_name
           FROM messages m LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.id IN (${replyIds.map(() => '?').join(',')})`,
          replyIds,
        )
      : [],
    all(`SELECT message_id, user_id FROM message_mentions WHERE message_id IN (${ph})`, ids),
    memberCount(chatId),
  ]);

  const senderMap = new Map(senders.map((s) => [s.id, s]));
  const attachmentMap = new Map(attachments.map((a) => [a.id, a]));
  const replyMap = new Map(replies.map((r) => [r.id, replyPreview(r, r.sender_name)]));
  const reactionMap = new Map();
  for (const r of reactions) {
    if (!reactionMap.has(r.message_id)) reactionMap.set(r.message_id, []);
    reactionMap.get(r.message_id).push({ emoji: r.emoji, count: Number(r.count), mine: Number(r.mine) === 1 });
  }
  const mentionMap = new Map();
  for (const row of mentionRows) {
    if (!mentionMap.has(row.message_id)) mentionMap.set(row.message_id, []);
    mentionMap.get(row.message_id).push(row.user_id);
  }
  const receiptMap = new Map();
  for (const r of receipts) {
    const entry = receiptMap.get(r.message_id) || { delivered: 0, read: 0 };
    if (r.delivered_at) entry.delivered += 1;
    if (r.read_at) entry.read += 1;
    receiptMap.set(r.message_id, entry);
  }

  return rows.map((row) => {
    const entry = receiptMap.get(row.id) || { delivered: 0, read: 0 };
    const others = Math.max(total - 1, 0);
    const status = others > 0 && entry.read >= others ? 'read' : others > 0 && entry.delivered >= others ? 'delivered' : 'sent';
    const isDeleted = Boolean(row.deleted_at);
    return toMessageDTO(
      {
        ...row,
        body: isDeleted || row.type === 'system' ? (row.type === 'system' ? null : '') : safeDecrypt(row.body),
      },
      {
        sender: senderMap.get(row.sender_id) ?? null,
        attachment: isDeleted ? null : toAttachmentDTO(attachmentMap.get(row.attachment_id), viewerId),
        replyTo: replyMap.get(row.reply_to_id) ?? null,
        reactions: reactionMap.get(row.id) ?? [],
        mentions: mentionMap.get(row.id) ?? [],
        mentionsMe: (mentionMap.get(row.id) ?? []).includes(viewerId),
        receipts: { delivered: entry.delivered, read: entry.read, total: others, status },
      },
      viewerId,
    );
  });
}

function safeDecrypt(payload) {
  if (!payload) return '';
  try {
    return decryptText(payload);
  } catch {
    return '';
  }
}

export async function listMessages(userId, chatId, { before, limit = config.messagePageSize, unlockToken } = {}) {
  const member = await assertMember(chatId, userId);
  assertUnlocked(member, chatId, userId, unlockToken);
  const rows = await all(
    `SELECT * FROM messages
     WHERE chat_id = ? AND seq < ?
       AND id NOT IN (SELECT message_id FROM message_hides WHERE user_id = ?)
     ORDER BY seq DESC LIMIT ?`,
    [chatId, before ?? 2 ** 40, userId, limit],
  );
  const hydrated = await hydrate(rows, userId, chatId);
  const hasMore = rows.length === limit;
  return { messages: hydrated.reverse(), hasMore, nextCursor: hasMore ? rows[rows.length - 1].seq : null };
}

export async function getMessage(userId, messageId) {
  const row = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!row) throw notFound('Message not found');
  await assertMember(row.chat_id, userId);
  const [dto] = await hydrate([row], userId, row.chat_id);
  return dto;
}

async function resolveAttachment(userId, attachmentId) {
  const att = await get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
  if (!att) throw notFound('Attachment not found');
  if (att.owner_id !== userId) throw forbidden('You can only share your own uploads');
  return att;
}

/**
 * Retries are expected (the client queue re-sends after a dropped connection),
 * so a send carrying a clientId is idempotent: the existing message is returned
 * instead of creating a duplicate.
 */
async function findByClientId(chatId, clientId) {
  if (!clientId) return null;
  return get('SELECT * FROM messages WHERE chat_id = ? AND client_id = ?', [chatId, clientId]);
}

/** Resolves @username tokens to members of this chat. */
async function resolveMentions(chatId, body) {
  if (!body || !body.includes('@')) return [];
  const usernames = [...new Set([...body.matchAll(/(?:^|[^\w@])@([a-zA-Z0-9._]{3,24})/g)].map((m) => m[1].toLowerCase()))];
  if (!usernames.length) return [];
  const rows = await all(
    `SELECT u.id FROM chat_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = ? AND u.username_lower IN (${usernames.map(() => '?').join(',')})`,
    [chatId, ...usernames],
  );
  return rows.map((r) => r.id);
}

export async function sendMessage(userId, input) {
  const { chatId, type = 'text', body, attachmentId, replyToId, clientId, unlockToken } = input;
  const member = await assertMember(chatId, userId);
  assertUnlocked(member, chatId, userId, unlockToken);

  const duplicate = await findByClientId(chatId, clientId);
  if (duplicate) {
    const [dto] = await hydrate([duplicate], userId, chatId);
    return { ...dto, clientId: clientId ?? undefined };
  }
  const chat = await getChat(chatId);

  if (chat.type === 'direct') {
    const peer = await directPeer(chatId, userId);
    if (peer && (await isBlockedBetween(userId, peer.id))) {
      throw forbidden('You cannot message this person');
    }
  }

  let text = null;
  if (type === 'text') {
    text = String(body ?? '').trim();
    if (!text) throw badRequest('Message cannot be empty');
    if (text.length > MAX_BODY) throw badRequest(`Messages are limited to ${MAX_BODY} characters`);
  } else if (type === 'image' || type === 'file') {
    if (!attachmentId) throw badRequest('An attachment is required');
    await resolveAttachment(userId, attachmentId);
    if (type === 'image') {
      const att = await get('SELECT mime FROM attachments WHERE id = ?', [attachmentId]);
      if (!att.mime.startsWith('image/')) throw badRequest('That file is not an image');
    }
  } else {
    throw badRequest('Unsupported message type');
  }

  if (replyToId) {
    const reply = await get('SELECT chat_id FROM messages WHERE id = ?', [replyToId]);
    if (!reply || reply.chat_id !== chatId) throw badRequest('Cannot reply to that message');
  }

  const now = Date.now();
  const messageId = newId();
  const members = await memberIds(chatId);
  const mentioned = type === 'text' ? await resolveMentions(chatId, text) : [];

  const seq = await tx(async (t) => {
    await t.execute({ sql: 'UPDATE chats SET seq = seq + 1, updated_at = ? WHERE id = ?', args: [now, chatId] });
    const res = await t.execute({ sql: 'SELECT seq FROM chats WHERE id = ?', args: [chatId] });
    const nextSeq = Number(res.rows[0].seq);
    await t.execute({
      sql: `INSERT INTO messages (id, chat_id, seq, sender_id, type, body, attachment_id, reply_to_id, created_at, client_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        messageId, chatId, nextSeq, userId, type, text ? encryptText(text) : null,
        attachmentId ?? null, replyToId ?? null, now, clientId ?? null,
      ],
    });
    for (const mentionedId of mentioned) {
      await t.execute({
        sql: 'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
        args: [messageId, mentionedId],
      });
    }
    await t.execute({
      sql: `INSERT INTO message_receipts (message_id, user_id, delivered_at)
            SELECT ?, user_id, NULL FROM chat_members WHERE chat_id = ? AND user_id != ?`,
      args: [messageId, chatId, userId],
    });
    return nextSeq;
  });

  const onlineOthers = members.filter((id) => id !== userId && isOnline(id));
  if (onlineOthers.length) {
    await run(
      `UPDATE message_receipts SET delivered_at = ?
       WHERE message_id = ? AND user_id IN (${onlineOthers.map(() => '?').join(',')})`,
      [now, messageId, ...onlineOthers],
    );
  }

  const row = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  const [dto] = await hydrate([row], userId, chatId);
  const payload = { ...dto, clientId: clientId ?? undefined };

  bus.emit(EVENTS.MESSAGE_NEW, { chatId, memberIds: members, message: payload, senderId: userId, mentions: mentioned });
  if (onlineOthers.length) {
    bus.emit(EVENTS.RECEIPT_UPDATE, {
      chatId,
      messageId,
      userIds: onlineOthers,
      deliveredAt: now,
      seq,
    });
  }
  return payload;
}

export async function editMessage(userId, messageId, body) {
  const row = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!row) throw notFound('Message not found');
  if (row.sender_id !== userId) throw forbidden('You can only edit your own messages');
  if (row.deleted_at) throw badRequest('This message was deleted');
  if (row.type !== 'text') throw badRequest('Only text messages can be edited');

  const text = String(body ?? '').trim();
  if (!text) throw badRequest('Message cannot be empty');

  await run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', [encryptText(text), Date.now(), messageId]);
  const updated = await getMessage(userId, messageId);
  const members = await memberIds(row.chat_id);
  bus.emit(EVENTS.MESSAGE_UPDATED, { chatId: row.chat_id, memberIds: members, message: updated });
  return updated;
}

export async function deleteMessage(userId, messageId) {
  const row = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!row) throw notFound('Message not found');
  if (row.sender_id !== userId) throw forbidden('You can only delete your own messages');

  const now = Date.now();
  await run('UPDATE messages SET deleted_at = ?, body = NULL, attachment_id = NULL WHERE id = ?', [now, messageId]);
  const members = await memberIds(row.chat_id);
  bus.emit(EVENTS.MESSAGE_DELETED, { chatId: row.chat_id, memberIds: members, messageId, seq: row.seq, deletedAt: now });
  return { id: messageId, deletedAt: now };
}

export async function toggleReaction(userId, messageId, emoji) {
  const row = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!row) throw notFound('Message not found');
  await assertMember(row.chat_id, userId);
  if (row.deleted_at) throw badRequest('This message was deleted');

  const existing = await get('SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [
    messageId, userId, emoji,
  ]);
  if (existing) {
    await run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, userId, emoji]);
  } else {
    await run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', [
      messageId, userId, emoji, Date.now(),
    ]);
  }

  const updated = await getMessage(userId, messageId);
  const members = await memberIds(row.chat_id);
  bus.emit(EVENTS.MESSAGE_UPDATED, { chatId: row.chat_id, memberIds: members, message: updated });
  return updated;
}

export async function markRead(userId, chatId, { messageId, seq } = {}) {
  await assertMember(chatId, userId);
  let targetSeq = seq;
  if (targetSeq == null && messageId) {
    const row = await get('SELECT seq, chat_id FROM messages WHERE id = ?', [messageId]);
    if (!row || row.chat_id !== chatId) throw notFound('Message not found');
    targetSeq = Number(row.seq);
  }
  if (targetSeq == null) {
    const row = await get('SELECT MAX(seq) AS seq FROM messages WHERE chat_id = ?', [chatId]);
    targetSeq = Number(row?.seq ?? 0);
  }

  const now = Date.now();
  await run(
    'UPDATE chat_members SET last_read_seq = MAX(last_read_seq, ?), last_read_at = ? WHERE chat_id = ? AND user_id = ?',
    [targetSeq, now, chatId, userId],
  );
  await run(
    `UPDATE message_receipts
       SET read_at = COALESCE(read_at, ?), delivered_at = COALESCE(delivered_at, ?)
     WHERE user_id = ? AND message_id IN (SELECT id FROM messages WHERE chat_id = ? AND seq <= ? AND sender_id != ?)`,
    [now, now, userId, chatId, targetSeq, userId],
  );

  bus.emit(EVENTS.RECEIPT_UPDATE, { chatId, userIds: [userId], readAt: now, seq: targetSeq, readerId: userId });
  return { chatId, lastReadSeq: targetSeq, readAt: now };
}

/** Per-user delete: hides the message for this viewer only. */
export async function hideMessage(userId, messageId) {
  const row = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!row) throw notFound('Message not found');
  await assertMember(row.chat_id, userId);
  await run('INSERT OR IGNORE INTO message_hides (message_id, user_id, created_at) VALUES (?, ?, ?)', [
    messageId,
    userId,
    Date.now(),
  ]);
  return { id: messageId, hidden: true };
}

/** Shared media for the gallery: images or files, newest first. */
export async function listMedia(userId, chatId, { type = 'image', limit = 60, unlockToken } = {}) {
  const member = await assertMember(chatId, userId);
  assertUnlocked(member, chatId, userId, unlockToken);

  const clause = type === 'file' ? "a.mime NOT LIKE 'image/%'" : "a.mime LIKE 'image/%'";
  const rows = await all(
    `SELECT m.id AS message_id, m.created_at AS message_created_at, a.*
     FROM messages m JOIN attachments a ON a.id = m.attachment_id
     WHERE m.chat_id = ? AND m.deleted_at IS NULL AND ${clause}
       AND m.id NOT IN (SELECT message_id FROM message_hides WHERE user_id = ?)
     ORDER BY m.seq DESC LIMIT ?`,
    [chatId, userId, limit],
  );

  return rows.map((r) => ({
    messageId: r.message_id,
    createdAt: r.message_created_at,
    attachment: toAttachmentDTO(r, userId),
  }));
}

/** Search decrypts a bounded window of recent messages (bodies are encrypted at rest). */
export async function searchMessages(userId, chatId, query, unlockToken) {
  const member = await assertMember(chatId, userId);
  assertUnlocked(member, chatId, userId, unlockToken);
  const needle = query.toLowerCase();
  const rows = await all(
    `SELECT * FROM messages
     WHERE chat_id = ? AND type = ? AND deleted_at IS NULL
       AND id NOT IN (SELECT message_id FROM message_hides WHERE user_id = ?)
     ORDER BY seq DESC LIMIT 400`,
    [chatId, 'text', userId],
  );
  const hits = rows.filter((r) => safeDecrypt(r.body).toLowerCase().includes(needle)).slice(0, 50);
  return hydrate(hits, userId, chatId);
}
