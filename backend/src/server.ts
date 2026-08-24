import http from 'node:http';
import { SERVICE_REGISTRATIONS } from './config/services.config';
import { env } from './config/env';
import { createApp } from './app';
import { HealthMonitor } from './services/healthMonitor.service';
import { ServiceRegistry } from './services/serviceRegistry';
import { logger } from './utils/logger';
import { createTokenBucketRateLimiter } from './services/rateLimiter.service';
import { createCircuitBreakerFromEnv } from './services/circuitBreaker.service';

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

// ─── Composition root ────────────────────────────────────────────────────────
const registry = new ServiceRegistry(SERVICE_REGISTRATIONS);
const healthMonitor = new HealthMonitor(registry.list(), {
  intervalMs: env.healthCheckIntervalMs,
  timeoutMs: env.upstreamTimeoutMs,
});
const rateLimiter = createTokenBucketRateLimiter();
const circuitBreaker = createCircuitBreakerFromEnv();
const app = createApp({ healthMonitor, rateLimiter, circuitBreaker });

const server = http.createServer(app);

server.listen(env.port, () => {
  logger.info('server_started', {
    service: env.serviceName,
    nodeEnv: env.nodeEnv,
    port: env.port,
    url: `http://localhost:${env.port}`,
    registeredServices: registry.size,
    healthCheckIntervalMs: env.healthCheckIntervalMs,
    upstreamTimeoutMs: env.upstreamTimeoutMs,
    circuitBreaker: {
      failureThreshold: env.circuitFailureThreshold,
      openDurationMs: env.circuitOpenDurationMs,
      halfOpenMaxRequests: env.circuitHalfOpenMaxRequests,
    },
  });
  // Background probing begins only after the gateway can accept traffic.
  healthMonitor.start();
});

/**
 * Shutdown order: stop the probe timer first (no new background work),
 * then stop accepting connections and let in-flight requests finish.
 */
function shutdown(signal: string): void {
  logger.warn('server_shutdown_initiated', { signal });

  healthMonitor.stop();

  server.close((error) => {
    if (error !== undefined) {
      logger.error('server_shutdown_forced', { reason: error.message });
      process.exit(1);
    }
    logger.info('server_shutdown_complete');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('server_shutdown_timeout');
    process.exit(1);
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('unhandled_rejection', {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
});

process.on('uncaughtException', (error: Error) => {
  logger.error('uncaught_exception', { errorMessage: error.message, stack: error.stack });
  shutdown('uncaughtException');
});
