/**
 * Errors that carry an HTTP status. Thrown from services and mapped to a JSON
 * response by the central error handler in server.js:
 *   { error: message, code?, details? }
 * `details` (e.g. a list of validation problems) is only ever sent for 4xx.
 */
class HttpError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, opts) => new HttpError(400, message, opts);
const notFound = (message = 'Not found.', opts) => new HttpError(404, message, opts);
const conflict = (message, opts) => new HttpError(409, message, opts);
const unprocessable = (message, opts) => new HttpError(422, message, opts);

module.exports = { HttpError, badRequest, notFound, conflict, unprocessable };
