/** Minimal observable store — one source of truth for the UI. */
const listeners = new Set();

export const state = {
  user: null,
  chats: [],
  activeChatId: null,
  chat: null,
  messages: [],
  hasMore: false,
  cursor: null,
  loadingMessages: false,
  typing: new Map(), // chatId -> Set(userId)
  online: new Map(), // userId -> boolean
  filter: 'all',
  query: '',
  panelOpen: false,
  replyTo: null,
  pendingAttachments: [],
  socketReady: false,
  unlocks: new Map(), // chatId -> short-lived unlock token
  unreadTotal: 0,
};

export function setState(patch, { silent = false } = {}) {
  Object.assign(state, patch);
  if (!silent) emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let frame = null;
export function emit() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    for (const fn of listeners) fn(state);
  });
}

export const activeChat = () => state.chats.find((c) => c.id === state.activeChatId) || null;

export function bumpUnread() {
  state.unreadTotal = state.chats.reduce((sum, c) => sum + (c.id === state.activeChatId ? 0 : c.unread || 0), 0);
  const title = state.unreadTotal > 0 ? `(${state.unreadTotal}) Speedy` : 'Speedy';
  if (document.title !== title) document.title = title;
}
