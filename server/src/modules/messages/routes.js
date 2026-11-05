import { Router } from 'express';
import { asyncHandler } from '../../lib/errors.js';
import { parse, schemas } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/security.js';
import * as messages from './service.js';

export const messagesRouter = Router();

/** Locked chats accept a short-lived token minted by POST /chats/:id/unlock. */
const unlockOf = (req) => req.get('x-chat-unlock') || undefined;

// requireAuth is applied per route (not via router.use) so that unknown /api
// paths still fall through to the JSON 404 handler instead of a 401.

messagesRouter.get(
  '/chats/:chatId/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { before, limit } = parse(schemas.listMessages, req.query);
    res.json({
      data: await messages.listMessages(req.user.id, req.params.chatId, {
        before,
        limit,
        unlockToken: unlockOf(req),
      }),
    });
  }),
);

messagesRouter.post(
  '/chats/:chatId/messages',
  requireAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.sendMessage, { ...req.body, chatId: req.params.chatId, unlock: unlockOf(req) });
    input.unlockToken = input.unlock;
    res.status(201).json({ data: { message: await messages.sendMessage(req.user.id, input) } });
  }),
);

messagesRouter.get(
  '/chats/:chatId/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { q } = parse(schemas.searchMessages, req.query);
    res.json({
      data: { messages: await messages.searchMessages(req.user.id, req.params.chatId, q, unlockOf(req)) },
    });
  }),
);

messagesRouter.post(
  '/chats/:chatId/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.markRead, req.body);
    res.json({ data: await messages.markRead(req.user.id, req.params.chatId, input) });
  }),
);

messagesRouter.patch(
  '/messages/:id',
  requireAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { body } = parse(schemas.editMessage, req.body);
    res.json({ data: { message: await messages.editMessage(req.user.id, req.params.id, body) } });
  }),
);

messagesRouter.delete(
  '/messages/:id',
  requireAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    res.json({ data: await messages.deleteMessage(req.user.id, req.params.id) });
  }),
);

messagesRouter.post(
  '/messages/:id/hide',
  requireAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    res.json({ data: await messages.hideMessage(req.user.id, req.params.id) });
  }),
);

messagesRouter.get(
  '/chats/:chatId/media',
  requireAuth,
  asyncHandler(async (req, res) => {
    const type = req.query.type === 'file' ? 'file' : 'image';
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 100);
    res.json({
      data: {
        items: await messages.listMedia(req.user.id, req.params.chatId, {
          type,
          limit,
          unlockToken: unlockOf(req),
        }),
      },
    });
  }),
);

messagesRouter.post(
  '/messages/:id/reactions',
  requireAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { emoji } = parse(schemas.react, req.body);
    res.json({ data: { message: await messages.toggleReaction(req.user.id, req.params.id, emoji) } });
  }),
);
