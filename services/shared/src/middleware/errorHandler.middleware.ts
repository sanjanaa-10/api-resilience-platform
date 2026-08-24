import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorBody } from '../types';
import { ApiError } from '../utils/ApiError';
import { createLogger } from '../utils/logger';

/**
 * Maps non-ApiError objects with a numeric `status` (e.g. body-parser
 * malformed-JSON errors) to their status so client mistakes become 4xx,
 * while genuine bugs stay sanitized 500s.
 */
function resolveStatusCode(err: unknown): number {
  if (err instanceof ApiError) return err.statusCode;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) return status;
  return 500;
}

/** Single exit point for every error — identical envelope across the platform. */
export function createErrorHandler(serviceName: string) {
  const logger = createLogger(serviceName);

  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const isApiError = err instanceof ApiError;
    const statusCode = resolveStatusCode(err);
    const error = err instanceof Error ? err : undefined;

    const isClientError = statusCode < 500;
    const message = isApiError
      ? err.message
      : isClientError && error?.message !== undefined
        ? error.message
        : 'Unexpected internal server error.';

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
      },
    };

    res.status(statusCode).json(body);
  };
}
