/** An error with an HTTP status and a message that is safe to show to the person. */
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const notFound = (what = "Not found") => new HttpError(404, what);
export const forbidden = (why = "You don't have access to this.") => new HttpError(403, why);

/** Wraps an async route handler so thrown errors reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
