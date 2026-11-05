import { Router } from 'express';
import { asyncHandler, notFound } from '../../lib/errors.js';
import { parse, schemas } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/security.js';
import * as users from './service.js';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const { q, limit } = parse(schemas.searchUsers, req.query);
    res.json({ data: { users: await users.searchUsers(q, req.user.id, limit) } });
  }),
);

usersRouter.patch(
  '/me',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.updateProfile, req.body);
    res.json({ data: { user: await users.updateProfile(req.user.id, input) } });
  }),
);

usersRouter.put(
  '/me/avatar',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { attachmentId } = req.body ?? {};
    if (typeof attachmentId !== 'string') throw notFound('attachmentId is required');
    res.json({ data: { user: await users.setAvatar(req.user.id, attachmentId) } });
  }),
);

usersRouter.get(
  '/me/export',
  asyncHandler(async (req, res) => {
    const data = await users.exportUserData(req.user.id);
    const stamp = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="speedy-export-${req.user.username}-${stamp}.json"`,
      'Cache-Control': 'no-store',
    });
    res.send(JSON.stringify(data, null, 2));
  }),
);

usersRouter.delete(
  '/me',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await users.deleteAccount(req.user.id, req.body?.password, req);
    res.status(204).end();
  }),
);

usersRouter.get(
  '/blocked',
  asyncHandler(async (req, res) => {
    res.json({ data: { users: await users.listBlocked(req.user.id) } });
  }),
);

usersRouter.post(
  '/:id/block',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await users.blockUser(req.user.id, req.params.id, req);
    res.status(204).end();
  }),
);

usersRouter.delete(
  '/:id/block',
  asyncHandler(async (req, res) => {
    await users.unblockUser(req.user.id, req.params.id);
    res.status(204).end();
  }),
);

usersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ data: { user: await users.getPublicUser(req.params.id, req.user.id) } });
  }),
);
