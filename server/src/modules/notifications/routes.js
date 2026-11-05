import { Router } from 'express';
import config from '../../config.js';
import { asyncHandler } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { isPushConfigured, removeSubscription, saveSubscription } from '../../lib/push.js';

export const pushRouter = Router();
pushRouter.use(requireAuth);

pushRouter.get(
  '/key',
  asyncHandler(async (req, res) => {
    res.json({ data: { enabled: isPushConfigured(), publicKey: config.push.publicKey || null } });
  }),
);

pushRouter.post(
  '/subscribe',
  asyncHandler(async (req, res) => {
    const result = await saveSubscription(req.user.id, req.body?.subscription);
    res.status(201).json({ data: result || { id: null } });
  }),
);

pushRouter.delete(
  '/subscribe',
  asyncHandler(async (req, res) => {
    await removeSubscription(req.user.id, String(req.body?.endpoint || ''));
    res.status(204).end();
  }),
);
