import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wrap an async route handler so rejected promises are forwarded to Express
 * error-handling middleware instead of becoming unhandled rejections.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Extract a human-readable message from an unknown error value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Shared HTTP error response helpers ──────────────────────────────────────

/** Send a 400 Bad Request response. */
export function badRequest(res: Response, message: string, extra?: Record<string, unknown>): void {
  res.status(400).json({ error: message, ...extra });
}

/** Send a 403 Forbidden response. */
export function forbidden(res: Response, message: string): void {
  res.status(403).json({ error: message });
}

/** Send a 404 Not Found response. */
export function notFound(res: Response, message: string): void {
  res.status(404).json({ error: message });
}

/** Send a 409 Conflict response. */
export function conflict(res: Response, message: string): void {
  res.status(409).json({ error: message });
}

/** Send a 422 Unprocessable Entity response. */
export function unprocessableEntity(res: Response, message: string, extra?: Record<string, unknown>): void {
  res.status(422).json({ error: message, ...extra });
}

/** Send a 502 Bad Gateway response. */
export function badGateway(res: Response, message: string): void {
  res.status(502).json({ error: message });
}

/**
 * Final Express error handler. Mount after all routers:
 *   app.use(errorHandler);
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error("[error-handler]", err);
  if (!res.headersSent) {
    res.status(500).json({ error: errorMessage(err) });
  }
}
