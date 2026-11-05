import { h, debounce } from './dom.js';
import { api, setAccessToken, refreshSession, ApiError, downloadAttachment } from './api.js';
import { state, setState, subscribe, emit, bumpUnread } from './store.js';
import { createAuthView } from './ui/auth.js';
import { createSidebar } from './ui/sidebar.js';
import { createChatPane } from './ui/chat.js';
import { createInfoPanel } from './ui/info.js';
import {
  profileModal, peoplePicker, promptDialog, confirmDialog, groupInfoModal,
  anyModalOpen, unlockModal, securityModal, adminModal, reportModal, galleryModal, lightbox,
} from './ui/modals.js';
import { toast, toastError } from './ui/toast.js';
import { connectSocket, emitAsync } from './socket.js';
import * as outbox from './queue.js';
import * as theme from './theme.js';

const root = document.getElementById('root');
const LAST_CHAT_KEY = 'speedy.lastChat';

let sidebar;
let chatPane;
let infoPanel;
let shell;
let subscribed = false;

/* ------------------------------- auth ------------------------------- */
function showAuth() {
  localStorage.removeItem(LAST_CHAT_KEY);
  setState({ user: null, chats: [], chat: null, messages: [], activeChatId: null });
  document.title = 'Speedy';
  const view = createAuthView({
    onAuthenticated: async (user) => {
      await startApp(user);
      toast(`Welcome, ${user.displayName.split(' ')[0]}`);
    },
  });
  root.replaceChildren(view.el);
  view.focus();
}

async function logout() {
  try {
    await api.logout();
  } catch {
    /* ignore */
  }
  try {
    (await import('./socket.js')).getSocket()?.disconnect();
  } catch {
    /* ignore */
  }
  setAccessToken(null);
  location.reload();
}

/* ------------------------------- shell ------------------------------- */
function buildShell() {
  sidebar = createSidebar({
    onSelectChat: openChat,
    onNewChat: newChat,
    onNewGroup: newGroup,
    onProfile: openProfile,
    onFilter: (filter) => setState({ filter }),
    onSearch: (query) => setState({ query }),
  });

  chatPane = createChatPane({
    onSend: sendMessage,
    onTyping: (isTyping) => {
      const socket = window.__speedySocket;
      if (socket && state.activeChatId) socket.emit('typing', { chatId: state.activeChatId, isTyping });
    },
    onReply: (message) => {
      setState({ replyTo: message });
      chatPane.focusComposer();
    },
    onCancelReply: () => setState({ replyTo: null }),
    onEdit: editMessage,
    onDelete: deleteMessage,
    onReact: reactToMessage,
    onOpenInfo: openInfo,
    onBack: closeChat,
    onLoadMore: loadOlder,
    onAttach,
    onDownload: (attachment) => downloadAttachment(attachment).catch(toastError),
    onUnblock: () => {
      if (state.chat) unblockPeer(state.chat);
    },
    onReport: reportMessage,
    onHide: hideMessageForMe,
    onGallery: openGallery,
    onCancelAttachment: () => setState({ pendingAttachment: null }),
    onNewChat: newChat,
    onNotify: (message, type) => toast(message, { type }),
  });

  infoPanel = createInfoPanel({
    onClose: () => setState({ panelOpen: false }),
    onChanged: () => refreshChats(),
    onLeft: (chatId) => {
      setState({ panelOpen: false });
      if (state.activeChatId === chatId) closeChat();
      refreshChats();
    },
    onBlocked: (chatId) => refreshChatDetail(chatId),
    onUnblocked: (chatId) => refreshChatDetail(chatId),
    onPin: togglePin,
    onLock: toggleLock,
    onManage: () => {
      if (state.chat?.type === 'group') {
        groupInfoModal({
          chat: state.chat,
          me: state.user,
          onChanged: async () => {
            await refreshChats();
            if (state.activeChatId) await openChat(state.activeChatId, { keepScroll: true });
          },
          onLeft: (chatId) => {
            if (state.activeChatId === chatId) closeChat();
            refreshChats();
          },
        });
      }
    },
  });

  shell = h('div', { class: 'app' }, sidebar.el, chatPane.el, infoPanel.el);
  root.replaceChildren(shell);

  if (!subscribed) {
    subscribe(render);
    subscribed = true;
  }
  render(state);
}

function render(current) {
  sidebar?.update(current);
  chatPane?.update(current);
  infoPanel?.render(current);
  infoPanel?.el.classList.toggle('hidden', !current.panelOpen);
  shell?.classList.toggle('with-panel', Boolean(current.panelOpen));
  shell?.classList.toggle('chat-open', Boolean(current.activeChatId));
  bumpUnread();
}

/* ------------------------------- data ------------------------------- */
async function refreshChats() {
  try {
    const data = await api.get('/api/chats');
    setState({ chats: data.chats });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showAuth();
    toastError(err);
  }
}

const refreshChatsSoon = debounce(refreshChats, 250);

const chatHeaders = (chatId) => {
  const token = state.unlocks.get(chatId);
  return token ? { 'X-Chat-Unlock': token } : {};
};

/** A locked chat needs the account password before anything is fetched. */
async function ensureUnlocked(chat) {
  if (!chat.locked || state.unlocks.has(chat.id)) return true;
  return unlockModal({
    title: chat.title,
    onSubmit: async (password) => {
      const res = await api.post(`/api/chats/${chat.id}/unlock`, { password });
      if (res.unlockToken) state.unlocks.set(chat.id, res.unlockToken);
    },
  });
}

async function openChat(chatId, { keepScroll = false } = {}) {
  try {
    const detail = await api.get(`/api/chats/${chatId}`);
    if (!(await ensureUnlocked(detail.chat))) return;

    const page = await api.get(`/api/chats/${chatId}/messages?limit=40`, { headers: chatHeaders(chatId) });
    setState({
      activeChatId: chatId,
      chat: detail.chat,
      messages: page.messages,
      hasMore: page.hasMore,
      cursor: page.nextCursor,
      replyTo: null,
      pendingAttachment: null,
    });
    localStorage.setItem(LAST_CHAT_KEY, chatId);
    window.__speedySocket?.emit('chat:join', { chatId });
    markRead();
    if (!keepScroll) chatPane.scrollToBottom();
    const entry = state.chats.find((c) => c.id === chatId);
    if (entry && entry.unread) {
      setState({ chats: state.chats.map((c) => (c.id === chatId ? { ...c, unread: 0 } : c)) });
    }
  } catch (err) {
    toastError(err);
  }
}

function closeChat() {
  setState({ activeChatId: null, chat: null, messages: [], panelOpen: false });
  localStorage.removeItem(LAST_CHAT_KEY);
}

async function loadOlder() {
  if (!state.cursor || state.loadingMessages) return;
  setState({ loadingMessages: true });
  try {
    const page = await api.get(`/api/chats/${state.activeChatId}/messages?before=${state.cursor}&limit=40`, {
      headers: chatHeaders(state.activeChatId),
    });
    const existing = new Set(state.messages.map((m) => m.id));
    setState({
      messages: [...page.messages.filter((m) => !existing.has(m.id)), ...state.messages],
      hasMore: page.hasMore,
      cursor: page.nextCursor,
      loadingMessages: false,
    });
  } catch (err) {
    setState({ loadingMessages: false });
    toastError(err);
  }
}

function markRead() {
  const socket = window.__speedySocket;
  const last = [...state.messages].reverse().find((m) => m.sender?.id !== state.user?.id);
  if (!socket || !state.activeChatId) return;
  socket.emit('message:read', { chatId: state.activeChatId, seq: last?.seq });
}

/* ------------------------------- actions ------------------------------- */
async function sendMessage({ text, attachment }) {
  const chatId = state.activeChatId;
  if (!chatId) return;
  const clientId = crypto.randomUUID();
  const replyTo = state.replyTo;
  const type = attachment ? (attachment.isImage ? 'image' : 'file') : 'text';
  const payload = {
    chatId,
    clientId,
    type,
    body: text || undefined,
    attachmentId: attachment?.id,
    replyToId: replyTo?.id,
    unlock: state.unlocks.get(chatId),
  };

  const optimistic = {
    id: `tmp-${clientId}`,
    clientId,
    chatId,
    seq: Number.MAX_SAFE_INTEGER - 1,
    type,
    body: text || '',
    createdAt: Date.now(),
    editedAt: null,
    deletedAt: null,
    sender: { id: state.user.id, displayName: state.user.displayName, avatarUrl: state.user.avatarUrl },
    attachment: attachment || null,
    replyTo: replyTo ? { id: replyTo.id, senderName: replyTo.sender?.displayName || 'You', preview: replyTo.type === 'text' ? replyTo.body : replyTo.type === 'image' ? 'Photo' : 'Attachment', type: replyTo.type } : null,
    reactions: [],
    receipts: { status: 'sent', delivered: 0, read: 0, total: 0 },
    pending: true,
  };

  setState({ messages: [...state.messages, optimistic], replyTo: null, pendingAttachment: null });
  chatPane.scrollToBottom();

  const result = await deliver(payload);

  if (result.ok && result.message) {
    replaceOptimistic(clientId, result.message);
    return;
  }

  if (result.retryable) {
    // Keep it on screen as "waiting", park it in the outbox and let the
    // reconnect handler replay it.
    outbox.enqueue(payload);
    setState({
      messages: state.messages.map((m) => (m.clientId === clientId ? { ...m, pending: true } : m)),
    });
    toast('Offline — queued to send when you reconnect');
    return;
  }

  setState({ messages: state.messages.filter((m) => m.clientId !== clientId) });
  toast(result.error?.message || 'Message failed to send', { type: 'error' });
}

/**
 * One attempt at delivery. The socket is preferred; REST is the fallback when
 * the socket is down but the network is up.
 */
async function deliver(payload) {
  const socketResult = await emitAsync('message:send', payload);
  if (socketResult.ok) return socketResult;

  const code = socketResult.error?.code;
  if (code !== 'offline' && code !== 'timeout') {
    // A real rejection (validation, permissions, locked chat) - retrying is pointless.
    return { ok: false, retryable: false, error: socketResult.error };
  }

  try {
    const data = await api.post(`/api/chats/${payload.chatId}/messages`, payload, {
      headers: chatHeaders(payload.chatId),
    });
    return { ok: true, message: data.message };
  } catch (err) {
    const retryable = err instanceof ApiError ? err.status >= 500 || err.status === 429 || err.status === 0 : true;
    return { ok: false, retryable, error: { message: err.message } };
  }
}

/** Replays the outbox in order; called on reconnect and on `online`. */
let flushing = false;
async function flushOutbox() {
  if (flushing || !outbox.size()) return;
  flushing = true;
  try {
    for (const item of outbox.all()) {
      const result = await deliver(item);
      if (result.ok && result.message) {
        outbox.dequeue(item.clientId);
        replaceOptimistic(item.clientId, result.message);
        continue;
      }
      if (!result.retryable) {
        outbox.dequeue(item.clientId);
        setState({ messages: state.messages.filter((m) => m.clientId !== item.clientId) });
        toast(result.error?.message || 'A queued message could not be sent', { type: 'error' });
        continue;
      }
      if (outbox.bump(item.clientId)) {
        outbox.dequeue(item.clientId);
        setState({
          messages: state.messages.map((m) => (m.clientId === item.clientId ? { ...m, pending: false, failed: true } : m)),
        });
        toast('A queued message could not be delivered', { type: 'error' });
      }
      break; // still offline - stop and wait for the next reconnect
    }
  } finally {
    flushing = false;
  }
}

function replaceOptimistic(clientId, message) {
  const next = [];
  let replaced = false;
  for (const m of state.messages) {
    if (m.clientId === clientId) {
      next.push(message);
      replaced = true;
    } else if (m.id !== message.id) {
      next.push(m);
    }
  }
  if (!replaced) next.push(message);
  setState({ messages: next });
  refreshChatsSoon();
}

async function editMessage(message) {
  const body = await promptDialog({ title: 'Edit message', label: 'New text', value: message.body, confirmText: 'Save', maxLength: 4000 });
  if (!body || body === message.body) return;
  try {
    const data = await api.patch(`/api/messages/${message.id}`, { body });
    upsertMessage(data.message);
  } catch (err) {
    toastError(err);
  }
}

async function deleteMessage(message) {
  const ok = await confirmDialog({
    title: 'Delete message',
    message: 'This removes the message for everyone in the chat.',
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/messages/${message.id}`);
    upsertMessage({ ...message, deletedAt: Date.now(), body: '', attachment: null });
  } catch (err) {
    toastError(err);
  }
}

async function reactToMessage(message, emoji) {
  try {
    const data = await api.post(`/api/messages/${message.id}/reactions`, { emoji });
    upsertMessage(data.message);
  } catch (err) {
    toastError(err);
  }
}

async function onAttach(file) {
  if (file.size > 10 * 1024 * 1024) {
    toast('Files must be under 10 MB', { type: 'error' });
    return;
  }
  toast('Uploading…', { timeout: 8000 });
  try {
    const attachment = await api.upload(file);
    setState({ pendingAttachment: attachment });
  } catch (err) {
    toastError(err);
  }
}

function upsertMessage(message) {
  if (!message || message.chatId !== state.activeChatId) return;
  const exists = state.messages.some((m) => m.id === message.id);
  setState({
    messages: exists ? state.messages.map((m) => (m.id === message.id ? message : m)) : [...state.messages, message],
  });
}

async function newChat() {
  const ids = await peoplePicker({ title: 'New chat', confirmText: 'Start chat' });
  if (!ids.length) return;
  try {
    const data = await api.post('/api/chats/direct', { userId: ids[0] });
    await refreshChats();
    await openChat(data.chat.id);
  } catch (err) {
    toastError(err);
  }
}

async function newGroup() {
  const title = await promptDialog({ title: 'New group', label: 'Group name', placeholder: 'Weekend trip', confirmText: 'Next' });
  if (!title) return;
  const ids = await peoplePicker({ title: `Add members to “${title}”`, confirmText: 'Create group', multi: true });
  if (!ids.length) return;
  try {
    const data = await api.post('/api/chats/group', { title, memberIds: ids });
    await refreshChats();
    await openChat(data.chat.id);
  } catch (err) {
    toastError(err);
  }
}

async function refreshChatDetail(chatId) {
  await refreshChats();
  try {
    const detail = await api.get(`/api/chats/${chatId}`);
    if (state.activeChatId === chatId) setState({ chat: detail.chat });
  } catch (err) {
    toastError(err);
  }
}

async function unblockPeer(chat) {
  try {
    await api.del(`/api/users/${chat.peer.id}/block`);
    toast(`${chat.title} unblocked`);
    await refreshChatDetail(chat.id);
  } catch (err) {
    toastError(err);
  }
}

async function togglePin(chat) {
  try {
    await api.patch(`/api/chats/${chat.id}/pin`, { pinned: !chat.pinned });
    await refreshChats();
    const detail = await api.get(`/api/chats/${chat.id}`);
    setState({ chat: detail.chat });
    toast(chat.pinned ? 'Chat unpinned' : 'Chat pinned to top');
  } catch (err) {
    toastError(err);
  }
}

async function toggleLock(chat) {
  try {
    if (!chat.locked) {
      await api.post(`/api/chats/${chat.id}/lock`, { locked: true });
      state.unlocks.delete(chat.id);
      setState({ panelOpen: false });
      closeChat();
      await refreshChats();
      toast('Chat locked');
      return;
    }

    const removed = await unlockModal({
      title: chat.title,
      message: `Remove the lock from “${chat.title}”? Enter your account password to confirm.`,
      onSubmit: async (password) => {
        await api.post(`/api/chats/${chat.id}/lock`, { locked: false, password });
      },
    });
    if (!removed) return;
    state.unlocks.delete(chat.id);
    toast('Lock removed');
    await refreshChats();
    const detail = await api.get(`/api/chats/${chat.id}`);
    setState({ chat: detail.chat });
  } catch (err) {
    toastError(err);
  }
}

async function hideMessageForMe(message) {
  try {
    await api.post(`/api/messages/${message.id}/hide`, {});
    setState({ messages: state.messages.filter((m) => m.id !== message.id) });
    toast('Message removed for you');
  } catch (err) {
    toastError(err);
  }
}

function openGallery() {
  if (!state.chat) return;
  galleryModal({
    chat: state.chat,
    unlockHeaders: chatHeaders(state.chat.id),
    onOpenImage: (url) => lightbox(url),
    onDownload: (attachment) => downloadAttachment(attachment).catch(toastError),
  });
}

async function reportMessage(message) {
  const choice = await reportModal({ message });
  if (!choice) return;
  try {
    await api.post('/api/reports', { messageId: message.id, reason: choice.reason });
    toast('Report sent to the moderators');
  } catch (err) {
    toastError(err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enableNotifications() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast('This browser does not support notifications', { type: 'error' });
      return;
    }
    const { enabled, publicKey } = await api.get('/api/push/key');
    if (!enabled) {
      toast('Push notifications are not configured on this server', { type: 'error' });
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notifications were blocked in the browser', { type: 'error' });
      return;
    }
    const registration = await navigator.serviceWorker.register('/sw.js');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api.post('/api/push/subscribe', { subscription: subscription.toJSON() });
    toast('Notifications enabled');
  } catch (err) {
    toastError(err);
  }
}

function cycleTheme() {
  const next = theme.cycle();
  toast(`Theme: ${next}`);
}

function openProfile() {
  profileModal({
    state,
    onUpdated: (user) => {
      setState({ user: { ...state.user, ...user } });
      refreshChatsSoon();
    },
    onLogout: logout,
    onSecurity: () => {
      document.querySelector('.modal-backdrop')?.remove();
      securityModal({ state, onChanged: () => api.get('/api/auth/me').then((d) => setState({ user: d.user })).catch(() => {}) });
    },
    onNotifications: () => {
      document.querySelector('.modal-backdrop')?.remove();
      enableNotifications();
    },
    onAdmin: () => {
      document.querySelector('.modal-backdrop')?.remove();
      adminModal({ state });
    },
    onTheme: cycleTheme,
    themeLabel: theme.label,
  });
}

function openInfo() {
  if (!state.chat) return;
  setState({ panelOpen: !state.panelOpen });
}

/* ------------------------------- socket ------------------------------- */
function wireSocket(socket) {
  window.__speedySocket = socket;

  socket.on('connect', () => {
    setState({ socketReady: true });
    if (state.activeChatId) socket.emit('chat:join', { chatId: state.activeChatId });
    flushOutbox();
  });
  socket.on('disconnect', () => setState({ socketReady: false }));

  socket.on('message:new', ({ message }) => {
    if (message.chatId === state.activeChatId) {
      if (message.clientId) replaceOptimistic(message.clientId, message);
      else upsertMessage(message);
      if (message.sender?.id !== state.user.id) markRead();
    }
    refreshChatsSoon();
  });

  socket.on('message:updated', ({ message }) => upsertMessage(message));

  socket.on('message:deleted', ({ chatId, messageId, deletedAt }) => {
    if (chatId !== state.activeChatId) return;
    setState({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, deletedAt, body: '', attachment: null } : m)),
    });
  });

  socket.on('receipt:update', ({ chatId, seq, readAt }) => {
    if (chatId !== state.activeChatId || !seq) return;
    setState({
      messages: state.messages.map((m) => {
        if (m.sender?.id !== state.user.id || m.seq > seq) return m;
        const status = readAt ? 'read' : m.receipts?.status === 'read' ? 'read' : 'delivered';
        return { ...m, receipts: { ...(m.receipts || {}), status } };
      }),
    });
  });

  socket.on('typing', ({ chatId, userId, isTyping }) => {
    const set = new Set(state.typing.get(chatId) || []);
    if (isTyping) set.add(userId);
    else set.delete(userId);
    state.typing.set(chatId, set);
    emit();
    if (isTyping) {
      clearTimeout(socket.__typingTimers?.[`${chatId}:${userId}`]);
      socket.__typingTimers = socket.__typingTimers || {};
      socket.__typingTimers[`${chatId}:${userId}`] = setTimeout(() => {
        const next = new Set(state.typing.get(chatId) || []);
        next.delete(userId);
        state.typing.set(chatId, next);
        emit();
      }, 4000);
    }
  });

  socket.on('presence', ({ userId, online, lastSeenAt }) => {
    state.online.set(userId, online);
    const chats = state.chats.map((c) => {
      if (c.type === 'direct' && c.peer?.id === userId) return { ...c, peer: { ...c.peer, online, lastSeenAt } };
      return c;
    });
    let chat = state.chat;
    if (chat) {
      if (chat.type === 'direct' && chat.peer?.id === userId) chat = { ...chat, peer: { ...chat.peer, online, lastSeenAt } };
      chat = { ...chat, members: chat.members.map((m) => (m.id === userId ? { ...m, online, lastSeenAt } : m)) };
    }
    setState({ chats, chat });
  });

  socket.on('chat:new', () => refreshChats());
  socket.on('chat:updated', () => {
    refreshChats();
    if (state.activeChatId) {
      api
        .get(`/api/chats/${state.activeChatId}`)
        .then((data) => setState({ chat: data.chat }))
        .catch(() => {});
    }
  });
}

/* ------------------------------- boot ------------------------------- */
async function startApp(user) {
  setState({ user });
  buildShell();
  const socket = connectSocket();
  wireSocket(socket);
  await refreshChats();
  if (outbox.size()) {
    toast(`${outbox.size()} message${outbox.size() === 1 ? '' : 's'} waiting to send`, { timeout: 4000 });
    flushOutbox();
  }
  const last = localStorage.getItem(LAST_CHAT_KEY);
  if (last && state.chats.some((c) => c.id === last)) openChat(last);
}

async function boot() {
  theme.apply();
  root.replaceChildren(h('div', { class: 'chat-empty' }, h('p', { text: 'Loading Speedy…' })));
  if (!document.cookie.includes('speedy_csrf')) return showAuth();
  try {
    const data = await refreshSession();
    setAccessToken(data.accessToken);
    await startApp(data.user);
  } catch {
    showAuth();
  }
}

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (anyModalOpen()) return;
    if (state.panelOpen) setState({ panelOpen: false });
    else if (state.replyTo) setState({ replyTo: null });
    else if (state.activeChatId && window.innerWidth <= 860) closeChat();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.querySelector('.search-input')?.focus();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !typing) {
    e.preventDefault();
    newChat();
  }
});

window.addEventListener('online', () => {
  toast('Back online');
  flushOutbox();
});
window.addEventListener('offline', () => toast('You are offline — messages will retry', { type: 'error' }));

boot();
