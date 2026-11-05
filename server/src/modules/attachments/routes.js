import { Router } from 'express';
import multer from 'multer';
import config from '../../config.js';
import { asyncHandler, unauthorized } from '../../lib/errors.js';
import { verifyAttachmentToken } from '../../lib/signed.js';
import { contentDisposition, INLINE_SAFE } from '../../lib/files.js';
import { authenticateRequest, requireAuth } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/security.js';
import * as attachments from './service.js';

function deadLinkPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f8;color:#14161c;
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px;text-align:center}
.card{max-width:420px;background:#fff;border:1px solid #e3e6ec;border-radius:18px;padding:32px}
h1{font-size:19px;margin:0 0 8px}p{margin:0;color:#6b7280;font-size:14.5px}</style></head>
<body><div class="card"><h1>This link has expired</h1>
<p>File links are valid for 12 hours. Open the conversation in Speedy and download the file from the message again.</p>
</div></body></html>`;
}

export const attachmentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 8 },
});

attachmentsRouter.post(
  '/',
  requireAuth,
  uploadLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const dto = await attachments.storeUpload({ userId: req.user.id, file: req.file });
    res.status(201).json({ data: { attachment: dto } });
  }),
);

// Browsers cannot attach an Authorization header to <img> or a download link,
// so this route also accepts the short-lived signature that DTOs embed.
attachmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    let userId = null;
    const session = await authenticateRequest(req);
    if (session) {
      userId = session.user.id;
    } else {
      const verified = verifyAttachmentToken(req.params.id, req.query.t);
      if (!verified) {
        // Someone pasted or bookmarked a dead link: give them a page they can
        // act on instead of a wall of JSON.
        if ((req.get('accept') || '').includes('text/html')) {
          return res.status(401).type('html').send(deadLinkPage());
        }
        throw unauthorized('Sign in again to view this file');
      }
      userId = verified.userId;
    }

    const { row } = await attachments.getAttachmentForUser(req.params.id, userId);
    const bytes = await attachments.readAttachmentBytes(row);
    const inline = INLINE_SAFE.has(row.mime);

    res.set({
      'Content-Type': row.mime,
      'Content-Length': String(bytes.length),
      'Content-Disposition': contentDisposition(row.original_name, inline),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });

    res.end(bytes);
  }),
);

attachmentsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await attachments.deleteOrphanUpload(req.user.id, req.params.id);
    res.status(204).end();
  }),
);
