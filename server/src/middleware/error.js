import multer from 'multer';
import config from '../config.js';
import logger from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

export function notFoundHandler(req, res, next) {
  next(new AppError(404, 'not_found', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'internal_error';
  let message = 'Something went wrong. Please try again.';
  let details;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed';
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB`
        : 'Upload failed';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'invalid_json';
    message = 'Malformed JSON body';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'payload_too_large';
    message = 'Request body too large';
  }

  if (status >= 500) {
    logger.error({ err, requestId: req.id, path: req.path, method: req.method }, 'unhandled error');
  } else {
    logger.debug({ code, path: req.path }, 'request rejected');
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(status >= 500 && !config.isProd ? { stack: err?.stack } : {}),
    },
  });
}
