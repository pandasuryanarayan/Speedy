import { Server } from 'socket.io';
import config from '../config.js';
import logger from '../lib/logger.js';
import { all, get, run } from '../db/index.js';
import { isOnline, markOffline, markOnline } from '../lib/presence.js';
import { pushToUsers } from '../lib/push.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { AppError } from '../lib/errors.js';
import { parse, schemas } from '../lib/validate.js';
import * as messages from '../modules/messages/service.js';
import { bus, EVENTS } from './bus.js';

const SOCKET_BUDGET = { points: 30, windowMs: 10_000 };

function takeToken(socket) {
  const now = Date.now();
  const bucket = socket.data.bucket;
  if (now - bucket.resetAt > SOCKET_BUDGET.windowMs) {
    bucket.resetAt = now;
    bucket.left = SOCKET_BUDGET.points;
  }
  if (bucket.left <= 0) return false;
  bucket.left -= 1;
  return true;
}

async function chatIdsFor(userId) {
  const rows = await all('SELECT chat_id FROM chat_members WHERE user_id = ?', [userId]);
  return rows.map((r) => r.chat_id);
}

async function broadcastPresence(io, userId, online) {
  const chatIds = await chatIdsFor(userId);
  for (const chatId of chatIds) {
    io.to(`chat:${chatId}`).emit('presence', { userId, online, lastSeenAt: online ? null : Date.now() });
  }
}

function attachRedisAdapter(io) {
  if (!config.redisUrl) return;
  // Optional: lets several app instances share rooms and broadcasts.
  void (async () => {
    try {
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const { createClient } = await import('redis');
      const pub = createClient({ url: config.redisUrl });
      const sub = pub.duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      logger.info('socket.io redis adapter attached');
    } catch (err) {
      logger.error({ err }, 'redis adapter failed - staying single-instance');
    }
  })();
}

export function createRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: true,
    maxHttpBufferSize: 256 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    cors: { origin: config.publicOrigin, credentials: true, methods: ['GET', 'POST'] },
  });

  attachRedisAdapter(io);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) throw new AppError(401, 'unauthorized', 'Missing token');

      const claims = await verifyAccessToken(token);
      const session = await get('SELECT revoked_at, expires_at, user_id FROM sessions WHERE id = ?', [claims.sessionId]);
      if (!session || session.revoked_at || Number(session.expires_at) <= Date.now() || session.user_id !== claims.userId) {
        throw new AppError(401, 'unauthorized', 'Session expired');
      }
      const user = await get('SELECT id, username, display_name, is_disabled FROM users WHERE id = ?', [claims.userId]);
      if (!user || user.is_disabled) throw new AppError(401, 'unauthorized', 'Account unavailable');

      socket.data.user = user;
      socket.data.sessionId = claims.sessionId;
      socket.data.chats = new Set();
      socket.data.bucket = { left: SOCKET_BUDGET.points, resetAt: Date.now() };
      next();
    } catch (err) {
      next(new Error(err?.message || 'Unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.user.id;
    try {
      socket.join(`user:${userId}`);
      for (const chatId of await chatIdsFor(userId)) {
        socket.join(`chat:${chatId}`);
        socket.data.chats.add(chatId);
      }
      const firstConnection = markOnline(userId);
      socket.emit('ready', { userId, chats: [...socket.data.chats] });
      if (firstConnection) await broadcastPresence(io, userId, true);
    } catch (err) {
      logger.error({ err, userId }, 'socket setup failed');
    }

    const ack = (cb) => (payload) => {
      if (typeof cb === 'function') cb(payload);
    };

    socket.on('chat:join', async ({ chatId } = {}, cb) => {
      try {
        const member = await get('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
        if (!member) throw new AppError(403, 'forbidden', 'Not a member of this chat');
        socket.join(`chat:${chatId}`);
        socket.data.chats.add(chatId);
        ack(cb)({ ok: true });
      } catch (err) {
        ack(cb)({ ok: false, error: { code: err.code ?? 'error', message: err.message } });
      }
    });

    socket.on('message:send', async (input, cb) => {
      try {
        if (!takeToken(socket)) throw new AppError(429, 'rate_limited', 'You are sending messages too quickly');
        const payload = parse(schemas.sendMessage, input);
        payload.unlockToken = payload.unlock;
        const message = await messages.sendMessage(userId, payload);
        ack(cb)({ ok: true, message });
      } catch (err) {
        if (!(err instanceof AppError)) logger.error({ err }, 'socket message:send failed');
        ack(cb)({
          ok: false,
          error: { code: err.code ?? 'error', message: err.message ?? 'Could not send message' },
        });
      }
    });

    socket.on('message:read', async (input, cb) => {
      try {
        const payload = parse(schemas.markRead.extend({ chatId: schemas.sendMessage.shape.chatId }), input);
        const result = await messages.markRead(userId, payload.chatId, payload);
        ack(cb)({ ok: true, ...result });
      } catch (err) {
        ack(cb)({ ok: false, error: { code: err.code ?? 'error', message: err.message } });
      }
    });

    socket.on('typing', ({ chatId, isTyping } = {}) => {
      if (!chatId || !socket.data.chats.has(chatId)) return;
      socket.to(`chat:${chatId}`).emit('typing', { chatId, userId, isTyping: Boolean(isTyping) });
    });

    socket.on('disconnect', async () => {
      try {
        const lastGone = markOffline(userId);
        if (lastGone) {
          await run('UPDATE users SET last_seen_at = ? WHERE id = ?', [Date.now(), userId]);
          await broadcastPresence(io, userId, false);
        }
      } catch (err) {
        logger.warn({ err, userId }, 'socket disconnect cleanup failed');
      }
    });
  });

  // Domain events -> socket fan-out
  bus.on(EVENTS.MESSAGE_NEW, ({ chatId, message, memberIds = [], senderId, mentions = [] }) => {
    io.to(`chat:${chatId}`).emit('message:new', { message });

    // Push only to members with no live socket - never wake someone who is
    // already looking at the conversation.
    const offline = memberIds.filter((id) => id !== senderId && !isOnline(id));
    if (!offline.length) return;
    const preview =
      message.type === 'text'
        ? String(message.body || '').slice(0, 140)
        : message.type === 'image'
          ? 'Photo'
          : message.type === 'file'
            ? 'Attachment'
            : 'New message';
    const mentionedOffline = offline.filter((id) => mentions.includes(id));
    void pushToUsers(offline, {
      title: message.sender?.displayName || 'Speedy',
      body: mentionedOffline.length ? `${preview} (mentioned you)` : preview,
      chatId,
      url: '/',
    });
  });
  bus.on(EVENTS.MESSAGE_UPDATED, ({ chatId, message }) => {
    io.to(`chat:${chatId}`).emit('message:updated', { message });
  });
  bus.on(EVENTS.MESSAGE_DELETED, ({ chatId, messageId, deletedAt }) => {
    io.to(`chat:${chatId}`).emit('message:deleted', { chatId, messageId, deletedAt });
  });
  bus.on(EVENTS.RECEIPT_UPDATE, (payload) => {
    io.to(`chat:${payload.chatId}`).emit('receipt:update', payload);
  });
  bus.on(EVENTS.CHAT_NEW, async ({ chatId, memberIds }) => {
    for (const memberId of memberIds) {
      io.in(`user:${memberId}`).socketsJoin(`chat:${chatId}`);
      io.to(`user:${memberId}`).emit('chat:new', { chatId });
    }
  });
  bus.on(EVENTS.CHAT_UPDATED, ({ chatId, memberIds }) => {
    for (const memberId of memberIds) {
      io.in(`user:${memberId}`).socketsJoin(`chat:${chatId}`);
    }
    io.to(`chat:${chatId}`).emit('chat:updated', { chatId });
  });

  return io;
}
