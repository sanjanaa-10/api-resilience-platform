import type { NextFunction, Request } from 'express';
import { ApiError } from '../utils/ApiError';

/** Catches every request that fell through the router and converts it to a 404. */
export function createNotFoundHandler(serviceName: string) {
  return (req: Request, _res: unknown, next: NextFunction): void => {
    next(
      ApiError.notFound(
        `Route ${req.method} ${req.originalUrl} does not exist on ${serviceName}.`,
      ),
    );
  };
}
