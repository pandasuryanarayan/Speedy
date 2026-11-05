import { Router } from 'express';
import { asyncHandler } from '../../lib/errors.js';
import { parse, schemas } from '../../lib/validate.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/security.js';
import * as moderation from './service.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const input = parse(schemas.createReport, req.body);
    res.status(201).json({ data: await moderation.createReport(req.user.id, input) });
  }),
);

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json({ data: await moderation.overview() });
  }),
);

adminRouter.get(
  '/reports',
  asyncHandler(async (req, res) => {
    const status = ['open', 'resolved', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
    res.json({ data: { reports: await moderation.listReports({ status }) } });
  }),
);

adminRouter.post(
  '/reports/:id/resolve',
  asyncHandler(async (req, res) => {
    const input = parse(schemas.resolveReport, req.body);
    res.json({ data: await moderation.resolveReport(req.user.id, req.params.id, input) });
  }),
);

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    res.json({ data: { users: await moderation.listUsers(String(req.query.q || '')) } });
  }),
);

adminRouter.post(
  '/users/:id/disable',
  asyncHandler(async (req, res) => {
    res.json({ data: await moderation.setUserDisabled(req.user.id, req.params.id, Boolean(req.body?.disabled)) });
  }),
);
