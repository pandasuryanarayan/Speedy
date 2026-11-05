import { Router } from 'express';
import { asyncHandler } from '../../lib/errors.js';
import { parse, schemas } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/security.js';
import * as chats from './service.js';

export const chatsRouter = Router();
chatsRouter.use(requireAuth);

chatsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ data: { chats: await chats.listChats(req.user.id) } });
  }),
);

chatsRouter.post(
  '/direct',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = parse(schemas.createDirectChat, req.body);
    res.status(201).json({ data: { chat: await chats.createDirectChat(req.user.id, userId) } });
  }),
);

chatsRouter.post(
  '/group',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.createGroupChat, req.body);
    res.status(201).json({ data: { chat: await chats.createGroupChat(req.user.id, input) } });
  }),
);

chatsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ data: { chat: await chats.getChatDetail(req.user.id, req.params.id) } });
  }),
);

chatsRouter.patch(
  '/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { title } = parse(schemas.updateChat, req.body);
    res.json({ data: { chat: await chats.updateChat(req.user.id, req.params.id, { title }) } });
  }),
);

chatsRouter.post(
  '/:id/members',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { memberIds } = parse(schemas.addMembers, req.body);
    res.json({ data: { chat: await chats.addMembers(req.user.id, req.params.id, memberIds) } });
  }),
);

chatsRouter.delete(
  '/:id/members/:userId',
  writeLimiter,
  asyncHandler(async (req, res) => {
    res.json({ data: { chat: await chats.removeMember(req.user.id, req.params.id, req.params.userId) } });
  }),
);

chatsRouter.patch(
  '/:id/members/:userId',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    res.json({ data: { chat: await chats.setRole(req.user.id, req.params.id, req.params.userId, role) } });
  }),
);

chatsRouter.post(
  '/:id/leave',
  asyncHandler(async (req, res) => {
    res.json({ data: await chats.leaveChat(req.user.id, req.params.id) });
  }),
);

chatsRouter.patch(
  '/:id/pin',
  writeLimiter,
  asyncHandler(async (req, res) => {
    res.json({ data: await chats.setPinned(req.user.id, req.params.id, Boolean(req.body?.pinned)) });
  }),
);

chatsRouter.post(
  '/:id/lock',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const locked = Boolean(req.body?.locked);
    const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
    res.json({ data: await chats.setLocked(req.user.id, req.params.id, { locked, password }) });
  }),
);

chatsRouter.post(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    res.json({ data: await chats.unlockChat(req.user.id, req.params.id, { password }) });
  }),
);

chatsRouter.patch(
  '/:id/mute',
  asyncHandler(async (req, res) => {
    res.json({ data: await chats.setMuted(req.user.id, req.params.id, Boolean(req.body?.muted)) });
  }),
);
