import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createLogger } from '../utils/logger';

/**
 * Assigns a correlation id to every request and emits one structured log
 * line when the response finishes — including service name, status and
 * response time, exactly what the gateway's observability pipeline will parse.
 */
export function createRequestLogger(serviceName: string): RequestHandler {
  const logger = createLogger(serviceName);

  return (req: Request, res: Response, next: NextFunction): void => {
    req.requestId = randomUUID();
    const startedAt = process.hrtime.bigint();

    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info('http_request', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      });
    });

    next();
  };
}
