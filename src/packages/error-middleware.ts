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
