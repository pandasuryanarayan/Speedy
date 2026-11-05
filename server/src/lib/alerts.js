import config from '../config.js';
import logger from './logger.js';

/**
 * Fire-and-forget security alerting to a Slack-compatible webhook. Every audit
 * event that matters is also pushed here, so an operator learns about a token
 * replay or a burst of lockouts without watching the log.
 */
const IMPORTANT = new Set([
  'auth.refresh_reuse',
  'auth.login_blocked',
  'auth.session_idle_timeout',
  'auth.session_absolute_timeout',
  'account.deleted',
  'admin.user_disabled',
  'moderation.message_removed',
  'security.malware_detected',
]);

export const shouldAlert = (action) => IMPORTANT.has(action);

export async function sendAlert(action, { userId = null, meta = null, ip = null } = {}) {
  const url = config.security.alertWebhook;
  if (!url) return;

  const text = [
    `:rotating_light: *Speedy security event*`,
    `action: \`${action}\``,
    userId ? `user: \`${userId}\`` : null,
    ip ? `ip: \`${ip}\`` : null,
    meta ? `meta: \`${JSON.stringify(meta).slice(0, 500)}\`` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    logger.warn({ err: err.message, action }, 'alert webhook failed');
  }
}
