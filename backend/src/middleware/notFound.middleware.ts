import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';

/** Catches every request that fell through the router and converts it to a 404. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist.`));
}
