import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Wraps async route handlers so rejected promises are forwarded to the
 * centralized error middleware instead of crashing the process or hanging
 * the request. Express 5 forwards rejections natively; keeping the wrapper
 * makes the behavior explicit and portable across versions.
 */
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
