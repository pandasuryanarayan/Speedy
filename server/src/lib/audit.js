import { newId } from './ids.js';
import { run } from '../db/index.js';
import logger from './logger.js';
import { sendAlert, shouldAlert } from './alerts.js';

/**
 * Security-relevant events (logins, lockouts, token reuse, group admin changes).
 * Never put secrets or message bodies in here.
 */
export async function audit(action, { userId = null, req = null, meta = null } = {}) {
  const entry = {
    id: newId(),
    user_id: userId,
    action,
    ip: req?.ip ?? null,
    user_agent: req?.get?.('user-agent')?.slice(0, 255) ?? null,
    meta: meta ? JSON.stringify(meta).slice(0, 2000) : null,
    created_at: Date.now(),
  };
  try {
    await run(
      'INSERT INTO audit_log (id, user_id, action, ip, user_agent, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [entry.id, entry.user_id, entry.action, entry.ip, entry.user_agent, entry.meta, entry.created_at],
    );
  } catch (err) {
    logger.warn({ err, action }, 'failed to write audit entry');
  }
  logger.info({ action, userId, ip: entry.ip }, 'audit');
  if (shouldAlert(action)) {
    void sendAlert(action, { userId, ip: entry.ip, meta: meta ?? null });
  }
}
