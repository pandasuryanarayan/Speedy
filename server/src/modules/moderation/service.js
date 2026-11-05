import { all, get, run } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { decryptText } from '../../lib/crypto.js';

/** Any member of the conversation can report a message they can see. */
export async function createReport(userId, { messageId, reason, details }) {
  const message = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!message) throw notFound('Message not found');
  const member = await get('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?', [message.chat_id, userId]);
  if (!member) throw forbidden('You can only report messages you can see');

  const id = newId();
  await run(
    `INSERT INTO reports (id, reporter_id, chat_id, message_id, reason, details, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [id, userId, message.chat_id, messageId, String(reason).slice(0, 64), (details || '').slice(0, 1000), Date.now()],
  );
  await audit('moderation.reported', { userId, meta: { messageId, reason } });
  return { id, status: 'open' };
}

export async function listReports({ status = 'open', limit = 50 } = {}) {
  const rows = await all(
    `SELECT r.*, u.username AS reporter, m.body AS message_body, m.type AS message_type, m.deleted_at
     FROM reports r
     LEFT JOIN users u ON u.id = r.reporter_id
     LEFT JOIN messages m ON m.id = r.message_id
     WHERE (? = 'all' OR r.status = ?)
     ORDER BY r.created_at DESC LIMIT ?`,
    [status, status, limit],
  );

  return rows.map((r) => {
    let body = null;
    try {
      body = r.message_body ? decryptText(r.message_body) : null;
    } catch {
      body = null;
    }
    return {
      id: r.id,
      status: r.status,
      reason: r.reason,
      details: r.details,
      reporter: r.reporter,
      chatId: r.chat_id,
      messageId: r.message_id,
      messagePreview: r.deleted_at ? 'Message deleted' : (body || '').slice(0, 300),
      messageType: r.message_type,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      resolution: r.resolution,
    };
  });
}

export async function resolveReport(adminId, reportId, { action }) {
  const report = await get('SELECT * FROM reports WHERE id = ?', [reportId]);
  if (!report) throw notFound('Report not found');
  if (report.status !== 'open') throw badRequest('That report is already closed');

  let resolution = 'dismissed';
  if (action === 'remove-message') {
    if (report.message_id) {
      await run('UPDATE messages SET deleted_at = ?, body = NULL, attachment_id = NULL WHERE id = ?', [
        Date.now(),
        report.message_id,
      ]);
    }
    resolution = 'message_removed';
  } else if (action === 'disable-user') {
    const message = report.message_id ? await get('SELECT sender_id FROM messages WHERE id = ?', [report.message_id]) : null;
    if (!message?.sender_id) throw badRequest('That message has no author to disable');
    await run('UPDATE users SET is_disabled = 1 WHERE id = ?', [message.sender_id]);
    await run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [Date.now(), message.sender_id]);
    resolution = 'user_disabled';
  }

  await run('UPDATE reports SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?', [
    action === 'dismiss' ? 'dismissed' : 'resolved',
    resolution,
    adminId,
    Date.now(),
    reportId,
  ]);
  await audit(`moderation.${resolution}`, { userId: adminId, meta: { reportId, messageId: report.message_id } });
  return { id: reportId, resolution };
}

export async function overview() {
  const [open, resolved, users, messages] = await Promise.all([
    get("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'"),
    get("SELECT COUNT(*) AS c FROM reports WHERE status != 'open'"),
    get('SELECT COUNT(*) AS c FROM users'),
    get('SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NULL'),
  ]);
  return {
    openReports: Number(open.c),
    resolvedReports: Number(resolved.c),
    users: Number(users.c),
    messages: Number(messages.c),
  };
}

export async function listUsers(query = '', limit = 50) {
  const needle = `%${String(query).toLowerCase()}%`;
  const rows = await all(
    `SELECT id, username, display_name, email, role, is_disabled, created_at, last_seen_at
     FROM users
     WHERE lower(username) LIKE ? OR lower(display_name) LIKE ? OR lower(coalesce(email, '')) LIKE ?
     ORDER BY created_at DESC LIMIT ?`,
    [needle, needle, needle, limit],
  );
  return rows.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
    disabled: Boolean(u.is_disabled),
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
  }));
}

export async function setUserDisabled(adminId, userId, disabled) {
  const user = await get('SELECT id, role FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('User not found');
  if (user.role === 'admin' && disabled) throw forbidden('Disable another admin from the database, not the UI');
  await run('UPDATE users SET is_disabled = ? WHERE id = ?', [disabled ? 1 : 0, userId]);
  if (disabled) {
    await run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [Date.now(), userId]);
  }
  await audit(disabled ? 'admin.user_disabled' : 'admin.user_enabled', { userId: adminId, meta: { target: userId } });
  return { id: userId, disabled: Boolean(disabled) };
}
