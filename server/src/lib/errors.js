export class AppError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code machine readable error code
   * @param {string} message safe, user facing message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

export const badRequest = (message = 'Bad request', details) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You are not allowed to do that') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message = 'Already exists', details) => new AppError(409, 'conflict', message, details);
export const payloadTooLarge = (message = 'Payload too large') => new AppError(413, 'payload_too_large', message);
export const unprocessable = (message = 'Validation failed', details) =>
  new AppError(422, 'validation_failed', message, details);
export const tooManyRequests = (message = 'Too many requests, slow down') =>
  new AppError(429, 'rate_limited', message);
export const internal = (message = 'Something went wrong') => new AppError(500, 'internal_error', message);

/** Wrap an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
