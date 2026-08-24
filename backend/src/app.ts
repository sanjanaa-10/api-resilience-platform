import express from 'express';
import type { Express } from 'express';
import { errorHandler } from './middleware/errorHandler.middleware';
import { notFoundHandler } from './middleware/notFound.middleware';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import { requestLogger } from './middleware/requestLogger.middleware';
import { createApiRouter } from './routes/index.routes';
import { createTokenBucketRateLimiter } from './services/rateLimiter.service';
import { createCircuitBreakerFromEnv } from './services/circuitBreaker.service';
import { createObservabilityServiceFromEnv } from './observability/observability.service';
import type { ObservabilityService } from './observability/observability.service';
import {
  createAnomalyDetectorFromEnv,
} from './anomaly/anomalyDetector.service';
import type { AnomalyDetector } from './anomaly/anomalyDetector.service';
import type { HealthMonitor } from './services/healthMonitor.service';

export interface AppDependencies {
  /** Injected so tests can supply a fake monitor; server.ts owns the real one. */
  healthMonitor: HealthMonitor;
  /** Optional rate limiter; if not provided one will be created via the factory. */
  rateLimiter?: ReturnType<typeof createTokenBucketRateLimiter>;
  /** Optional breaker; if not provided one will be created from env config. */
  circuitBreaker?: ReturnType<typeof createCircuitBreakerFromEnv>;
  /** Optional observability facade; defaults to an env-configured instance. */
  observability?: ObservabilityService;
  /** Optional anomaly detector; defaults to an env-configured instance. */
  anomalyDetector?: AnomalyDetector;
}

/**
 * Builds the Express application.
 * Middleware order matters:
 *   0. CORS headers (read-only allowance for the Phase-10 browser client;
 *      placed first so every response — including errors and rate-limit
 *      rejections — stays readable from the dev-server origin. OPTIONS
 *      short-circuits before rate limiting so preflights never burn tokens)
 *   1. request id resolution (reuse X-Request-ID or generate — everything
 *      downstream, including the logger, depends on it)
 *   2. body parsing
 *   3. request logging (finish hook emits the structured log line)
 *   4. rate limiting (consumes one token per client request)
 *   5. routes
 *   6. notFound handler (catches unmatched routes)
 *   7. centralized error handler (must be last, arity-4 middleware)
 *
 * Rate limiting happens BEFORE the proxy and retry logic so that
 * one client request consumes exactly one gateway rate-limit token,
 * regardless of internal retries.
 */
export function createApp(dependencies: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');

  // Minimal CORS for the browser client (frontend dev server on :5173 calls
  // this API directly). Read-only: GET/OPTIONS, no credentials, no cookies.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(requestIdMiddleware);
  app.use(express.json({ limit: '16kb' }));
  app.use(requestLogger);
  const rateLimiter = dependencies.rateLimiter ?? createTokenBucketRateLimiter();
  // Wrap in an arrow function to preserve `this` context.
  // Express calls middleware without a receiver, so `this` would be
  // undefined inside the class method. The arrow function closes over
  // the `rateLimiter` instance, ensuring `this` correctly references
  // the TokenBucketRateLimiter when its methods are invoked.
  app.use((req, res, next) => rateLimiter.middleware(req, res, next));

  app.use(createApiRouter({
    healthMonitor: dependencies.healthMonitor,
    circuitBreaker: dependencies.circuitBreaker ?? createCircuitBreakerFromEnv(),
    observability: dependencies.observability ?? createObservabilityServiceFromEnv(),
    anomalyDetector: dependencies.anomalyDetector ?? createAnomalyDetectorFromEnv(),
  }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
