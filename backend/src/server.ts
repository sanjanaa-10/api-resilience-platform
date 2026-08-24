import http from 'node:http';
import { SERVICE_REGISTRATIONS } from './config/services.config';
import { env } from './config/env';
import { createApp } from './app';
import { HealthMonitor } from './services/healthMonitor.service';
import { ServiceRegistry } from './services/serviceRegistry';
import { logger } from './utils/logger';
import { createTokenBucketRateLimiter } from './services/rateLimiter.service';
import {
  createCircuitBreakerFromEnv,
  type CircuitTransition,
} from './services/circuitBreaker.service';
import { createObservabilityServiceFromEnv } from './observability/observability.service';
import type { EventInput, EventSeverity, EventType } from './observability/events';
import {
  createAnomalyDetectorFromEnv,
} from './anomaly/anomalyDetector.service';
import { MetricSampler } from './anomaly/metricSampler.service';

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

// ─── Composition root ────────────────────────────────────────────────────────
// Observability is built FIRST so every other component can be wired to it
// through its optional hook. The belt-and-suspenders safeRecord wrapper
// guarantees a broken hook can never reach the request path.
const observability = createObservabilityServiceFromEnv();
const safeRecord = (input: EventInput): void => {
  try {
    observability.record(input);
  } catch (error) {
    logger.error('observability_hook_error', { errorMessage: (error as Error).message });
  }
};

const registry = new ServiceRegistry(SERVICE_REGISTRATIONS);
const healthMonitor = new HealthMonitor(registry.list(), {
  intervalMs: env.healthCheckIntervalMs,
  timeoutMs: env.upstreamTimeoutMs,
  onStateChange: (next, previous) => {
    const severity: EventSeverity = next.status === 'healthy' ? 'INFO' : 'WARNING';
    safeRecord({
      eventType: 'HEALTH_CHANGED',
      service: next.name,
      severity,
      message: `Health changed ${previous?.status ?? 'unknown'} -> ${next.status}`,
      metadata: {
        from: previous?.status ?? null,
        to: next.status,
        latencyMs: next.latencyMs,
        error: next.lastError,
      },
    });
  },
});
const rateLimiter = createTokenBucketRateLimiter({
  onRejected: ({ requestId, clientId, path, retryAfterSeconds }) => {
    safeRecord({
      eventType: 'RATE_LIMITED',
      service: 'gateway',
      requestId: requestId ?? null,
      message: `Rate limit exceeded for client ${clientId}`,
      metadata: { clientId, path, retryAfterSeconds },
    });
  },
});
const onCircuitTransition = (transition: CircuitTransition): void => {
  const eventType: EventType =
    transition.to === 'OPEN'
      ? 'CIRCUIT_OPENED'
      : transition.to === 'HALF_OPEN'
        ? 'CIRCUIT_HALF_OPEN'
        : 'CIRCUIT_CLOSED';
  const severity: EventSeverity = transition.to === 'OPEN' ? 'CRITICAL' : 'INFO';
  safeRecord({
    eventType,
    service: transition.service,
    severity,
    requestId: transition.requestId ?? null,
    message: `Circuit ${transition.from} -> ${transition.to} (${transition.reason})`,
    metadata: {
      reason: transition.reason,
      failureCount: transition.failureCount,
    },
  });
};
const circuitBreaker = createCircuitBreakerFromEnv(onCircuitTransition);

// Anomaly detection: detector consumes ONLY metrics from the observability
// layer; the sampler is one shared, unref'd, stoppable timer. Emissions flow
// into the SAME event stream (store + incidents as supporting evidence).
const anomalyDetector = createAnomalyDetectorFromEnv({
  emit: (emission) => {
    const severity: EventSeverity =
      emission.eventType === 'ANOMALY_RESOLVED'
        ? 'INFO'
        : emission.status === 'ANOMALOUS'
          ? 'CRITICAL'
          : 'WARNING';
    safeRecord({
      eventType: emission.eventType,
      service: emission.service,
      severity,
      message:
        emission.eventType === 'ANOMALY_DETECTED'
          ? `Anomaly detected on ${emission.service} (score ${emission.score}, status ${emission.status})`
          : `Anomaly resolved on ${emission.service} (score ${emission.score})`,
      metadata: {
        status: emission.status,
        previousStatus: emission.previousStatus,
        score: emission.score,
        reasons: emission.reasons,
      },
    });
  },
});
const metricSampler = new MetricSampler({
  getMetrics: () => observability.getMetrics(),
  onSample: (feature) => {
    try {
      anomalyDetector.observe(feature);
    } catch (error) {
      logger.error('anomaly_observe_error', { errorMessage: (error as Error).message });
    }
  },
  intervalMs: env.anomalySampleIntervalMs,
});

const app = createApp({ healthMonitor, rateLimiter, circuitBreaker, observability, anomalyDetector });

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
    anomalyDetection: {
      sampleIntervalMs: env.anomalySampleIntervalMs,
      windowSize: env.anomalyWindowSize,
      minSamples: env.anomalyMinSamples,
    },
  });
  // Background probing begins only after the gateway can accept traffic.
  healthMonitor.start();
  // Metric sampling for anomaly baselines starts with the gateway and stops
  // with it (unref'd timer — never blocks shutdown).
  metricSampler.start();
});

/**
 * Shutdown order: stop the probe timer first (no new background work),
 * then stop accepting connections and let in-flight requests finish.
 */
function shutdown(signal: string): void {
  logger.warn('server_shutdown_initiated', { signal });

  healthMonitor.stop();
  metricSampler.stop();

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
