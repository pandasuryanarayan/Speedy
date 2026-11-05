import { isOnline } from './presence.js';
import { signAttachmentUrl } from './signed.js';

/**
 * A URL the browser can load directly (img src, download link). It carries a
 * short-lived signature bound to the viewer because those elements cannot send
 * an Authorization header.
 */
export function attachmentUrl(id, viewerId = null) {
  if (!id) return null;
  const token = viewerId ? signAttachmentUrl(id, viewerId) : null;
  return token ? `/api/attachments/${id}?t=${token}` : `/api/attachments/${id}`;
}

export function toUserDTO(row, { self = false, viewerId = null } = {}) {
  if (!row) return null;
  const dto = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    about: row.about ?? '',
    avatarUrl: attachmentUrl(row.avatar_attachment_id, viewerId ?? row.id),
    online: isOnline(row.id),
    lastSeenAt: row.last_seen_at ?? null,
  };
  if (self) {
    dto.role = row.role;
    dto.createdAt = row.created_at;
    dto.email = row.email ?? null;
    dto.emailVerified = Boolean(row.email_verified_at);
    dto.mfaEnabled = Boolean(row.totp_enabled_at);
  }
  return dto;
}

export function toAttachmentDTO(row, viewerId = null) {
  if (!row) return null;
  const mime = row.mime || 'application/octet-stream';
  return {
    id: row.id,
    name: row.original_name,
    mime,
    size: row.size,
    url: attachmentUrl(row.id, viewerId ?? row.owner_id),
    isImage: mime.startsWith('image/'),
  };
}

export function toMessageDTO(row, extras = {}, viewerId = null) {
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
    sender: sender
      ? {
          id: sender.id,
          displayName: sender.display_name,
          username: sender.username,
          avatarUrl: attachmentUrl(sender.avatar_attachment_id, viewerId),
        }
      : null,
    attachment,
    replyTo,
    reactions,
    receipts,
    clientId,
  };
}
