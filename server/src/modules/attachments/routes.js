import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import config from '../../config.js';
import { asyncHandler } from '../../lib/errors.js';
import { contentDisposition, INLINE_SAFE } from '../../lib/files.js';
import { requireAuth } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/security.js';
import * as attachments from './service.js';

export const attachmentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 8 },
});

attachmentsRouter.use(requireAuth);

attachmentsRouter.post(
  '/',
  uploadLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const dto = await attachments.storeUpload({ userId: req.user.id, file: req.file });
    res.status(201).json({ data: { attachment: dto } });
  }),
);

attachmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res, next) => {
    const { row, filePath } = await attachments.getAttachmentForUser(req.params.id, req.user.id);
    const inline = INLINE_SAFE.has(row.mime);

    res.set({
      'Content-Type': row.mime,
      'Content-Length': String(row.size),
      'Content-Disposition': contentDisposition(row.original_name, inline),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', next);
    stream.pipe(res);
  }),
);

attachmentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await attachments.deleteOrphanUpload(req.user.id, req.params.id);
    res.status(204).end();
  }),
);
