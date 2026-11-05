/**
 * Outbox for messages that could not be delivered yet.
 *
 * Persisted to localStorage so a reload does not lose them, and replayed in
 * order when the socket reconnects or the browser comes back online. Sends are
 * idempotent server-side (messages carry a clientId), so a replay after a
 * timeout cannot create duplicates.
 */
const KEY = 'speedy.outbox.v1';
const MAX_ATTEMPTS = 5;

let items = read();
const listeners = new Set();

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage full or disabled - keep the in-memory copy */
  }
  for (const fn of listeners) fn(items);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const all = () => [...items];
export const size = () => items.length;
export const has = (clientId) => items.some((item) => item.clientId === clientId);

export function enqueue(payload) {
  if (!payload?.clientId || has(payload.clientId)) return;
  items.push({ ...payload, attempts: 0, queuedAt: Date.now() });
  persist();
}

export function dequeue(clientId) {
  const before = items.length;
  items = items.filter((item) => item.clientId !== clientId);
  if (items.length !== before) persist();
}

/** Counts a failed attempt; returns the item when it has run out of retries. */
export function bump(clientId) {
  const item = items.find((entry) => entry.clientId === clientId);
  if (!item) return null;
  item.attempts += 1;
  persist();
  return item.attempts >= MAX_ATTEMPTS ? item : null;
}

export function clear() {
  items = [];
  persist();
}
