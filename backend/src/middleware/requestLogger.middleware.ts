import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * Emits one structured log line per request when the response finishes.
 * Runs AFTER requestId.middleware so the correlation id (and its origin)
 * is already resolved and included in every log entry.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info('http_request', {
      requestId: req.requestId,
      requestIdSource: req.requestIdSource ?? 'gateway',
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    });
  });

  next();
}
