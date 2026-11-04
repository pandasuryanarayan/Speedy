import { isOnline } from './presence.js';

export const attachmentUrl = (id) => (id ? `/api/attachments/${id}` : null);

export function toUserDTO(row, { self = false } = {}) {
  if (!row) return null;
  const dto = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    about: row.about ?? '',
    avatarUrl: attachmentUrl(row.avatar_attachment_id),
    online: isOnline(row.id),
    lastSeenAt: row.last_seen_at ?? null,
  };
  if (self) {
    dto.role = row.role;
    dto.createdAt = row.created_at;
  }
  return dto;
}

export function toAttachmentDTO(row) {
  if (!row) return null;
  const mime = row.mime || 'application/octet-stream';
  return {
    id: row.id,
    name: row.original_name,
    mime,
    size: row.size,
    url: attachmentUrl(row.id),
    isImage: mime.startsWith('image/'),
  };
}

export function toMessageDTO(row, extras = {}) {
  const { sender = null, attachment = null, replyTo = null, reactions = [], receipts = null, clientId } = extras;
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    type: row.type,
    body: row.body ?? '',
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
    sender: sender ? { id: sender.id, displayName: sender.display_name, username: sender.username, avatarUrl: attachmentUrl(sender.avatar_attachment_id) } : null,
    attachment,
    replyTo,
    reactions,
    receipts,
    clientId,
  };
}
