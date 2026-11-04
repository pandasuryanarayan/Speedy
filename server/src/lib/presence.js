/**
 * In-memory presence registry. For multi-instance deployments, swap this for a
 * Redis backed store (see docs/SCALING.md) - the interface stays the same.
 */
const connections = new Map(); // userId -> socket count

export function markOnline(userId) {
  const next = (connections.get(userId) || 0) + 1;
  connections.set(userId, next);
  return next === 1;
}

export function markOffline(userId) {
  const current = connections.get(userId) || 0;
  if (current <= 1) {
    connections.delete(userId);
    return current > 0;
  }
  connections.set(userId, current - 1);
  return false;
}

export const isOnline = (userId) => (connections.get(userId) || 0) > 0;

export function onlineAmong(userIds = []) {
  return userIds.filter((id) => isOnline(id));
}
