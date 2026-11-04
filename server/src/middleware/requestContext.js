import crypto from 'node:crypto';

export function requestContext(req, res, next) {
  req.id = req.get('x-request-id')?.slice(0, 64) || crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}
