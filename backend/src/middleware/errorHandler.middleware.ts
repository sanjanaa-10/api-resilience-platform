import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import type { ApiErrorBody } from '../types';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

/**
 * Single exit point for every error in the system.
 * - Known ApiErrors        -> their status code + message.
 * - Anything unexpected    -> sanitized 500 (never leaks internals to clients).
 * - 5xx are logged with stack traces; stack reaches the client only in development.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const isApiError = err instanceof ApiError;
  const statusCode = isApiError ? err.statusCode : 500;
  const message = isApiError ? err.message : 'Unexpected internal server error.';

  const error = err instanceof Error ? err : undefined;

  if (statusCode >= 500) {
    logger.error('unhandled_error', {
      requestId: req.requestId,
      errorMessage: error?.message ?? String(err),
      stack: error?.stack,
      isOperational: isApiError && err.isOperational,
    });
  }

  const body: ApiErrorBody = {
    success: false,
    error: {
      message,
      statusCode,
      ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
      ...(isApiError && err.details !== undefined ? { details: err.details } : {}),
      ...(env.nodeEnv === 'development' && error?.stack !== undefined
        ? { stack: error.stack }
        : {}),
    },
  };

  res.status(statusCode).json(body);
}
