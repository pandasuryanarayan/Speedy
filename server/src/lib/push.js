import webpush from 'web-push';
import config from '../config.js';
import { all, get, run } from '../db/index.js';
import { newId } from './ids.js';
import logger from './logger.js';

/**
 * Web Push (VAPID). Optional: without keys the app simply never asks the
 * browser for permission and notifications are skipped.
 */
export const isPushConfigured = () => Boolean(config.push.publicKey && config.push.privateKey);

let configured = false;
function ensureConfigured() {
  if (!isPushConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
    configured = true;
  }
  return true;
}

export async function saveSubscription(userId, subscription) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return null;
  const existing = await get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [subscription.endpoint]);
  if (existing) {
    await run('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE id = ?', [
      userId,
      subscription.keys.p256dh,
      subscription.keys.auth,
      existing.id,
    ]);
    return { id: existing.id };
  }
  const id = newId();
  await run(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now()],
  );
  return { id };
}

export async function removeSubscription(userId, endpoint) {
  await run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, userId]);
}

/** Sends to every device of the given users, pruning dead endpoints. */
export async function pushToUsers(userIds, payload) {
  if (!ensureConfigured() || !userIds.length) return { sent: 0 };

  const placeholders = userIds.map(() => '?').join(',');
  const subs = await all(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`, userIds);
  let sent = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 3600 },
        );
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
        } else {
          logger.warn({ err: err.message }, 'push delivery failed');
        }
      }
    }),
  );

  return { sent };
}
