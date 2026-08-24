import 'dotenv/config';
import type { Env, LogLevel, NodeEnv } from '../types';

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined || raw.trim() === '') return 'development';
  const value = raw as NodeEnv;
  if (!NODE_ENVS.includes(value)) {
    throw new Error(`Invalid NODE_ENV "${raw}" — expected one of: ${NODE_ENVS.join(', ')}.`);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 4000;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}" — expected an integer between 1 and 65535.`);
  }
  return port;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw.trim() === '') return 'info';
  const value = raw as LogLevel;
  if (!LOG_LEVELS.includes(value)) {
    throw new Error(`Invalid LOG_LEVEL "${raw}" — expected one of: ${LOG_LEVELS.join(', ')}.`);
  }
  return value;
}

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${label} "${raw}" — expected an integer between ${min} and ${max}.`);
  }
  return value;
}

function parseOptionalBaseUrl(raw: string | undefined, label: string): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    throw new Error(`Invalid ${label} "${raw}" — must be a valid http(s) URL.`);
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Reads and validates environment variables once at boot.
 * Fails fast (process exit) instead of letting a bad config surface mid-request.
 */
export function loadEnv(): Env {
  try {
    const config: Env = {
      nodeEnv: parseNodeEnv(process.env.NODE_ENV),
      port: parsePort(process.env.PORT),
      serviceName: process.env.SERVICE_NAME?.trim() || 'api-resilience-platform',
      logLevel: parseLogLevel(process.env.LOG_LEVEL),
      healthCheckIntervalMs: parseIntInRange(
        process.env.HEALTH_CHECK_INTERVAL_MS,
        5000,
        100,
        3_600_000,
        'HEALTH_CHECK_INTERVAL_MS',
      ),
      upstreamTimeoutMs: parseIntInRange(
        process.env.UPSTREAM_TIMEOUT_MS,
        3000,
        50,
        60_000,
        'UPSTREAM_TIMEOUT_MS',
      ),
      retryMaxAttempts: parseIntInRange(
        process.env.RETRY_MAX_ATTEMPTS,
        3,
        1,
        10,
        'RETRY_MAX_ATTEMPTS',
      ),
      retryBaseDelayMs: parseIntInRange(
        process.env.RETRY_BASE_DELAY_MS,
        100,
        0,
        60_000,
        'RETRY_BASE_DELAY_MS',
      ),
      retryMaxDelayMs: parseIntInRange(
        process.env.RETRY_MAX_DELAY_MS,
        1000,
        0,
        300_000,
        'RETRY_MAX_DELAY_MS',
      ),
      retryTotalBudgetMs: parseIntInRange(
        process.env.RETRY_TOTAL_BUDGET_MS,
        10_000,
        100,
        300_000,
        'RETRY_TOTAL_BUDGET_MS',
      ),
      paymentBaseUrl: parseOptionalBaseUrl(process.env.PAYMENT_SERVICE_URL, 'PAYMENT_SERVICE_URL'),
      aiBaseUrl: parseOptionalBaseUrl(process.env.AI_SERVICE_URL, 'AI_SERVICE_URL'),
      aiFallbackBaseUrl: parseOptionalBaseUrl(
        process.env.AI_FALLBACK_SERVICE_URL,
        'AI_FALLBACK_SERVICE_URL',
      ),
      notificationBaseUrl: parseOptionalBaseUrl(
        process.env.NOTIFICATION_SERVICE_URL,
        'NOTIFICATION_SERVICE_URL',
      ),
      rateLimitCapacity: parseIntInRange(
        process.env.RATE_LIMIT_CAPACITY,
        20,
        1,
        1_000,
        'RATE_LIMIT_CAPACITY',
      ),
      rateLimitRefillRate: parseFloat(
        process.env.RATE_LIMIT_REFILL_RATE || '10',
      ),
      rateLimitCleanupIntervalMs: parseIntInRange(
        process.env.RATE_LIMIT_CLEANUP_INTERVAL_MS,
        60_000,
        1_000,
        3_600_000,
        'RATE_LIMIT_CLEANUP_INTERVAL_MS',
      ),
      circuitFailureThreshold: parseIntInRange(
        process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        5,
        1,
        100,
        'CIRCUIT_BREAKER_FAILURE_THRESHOLD',
      ),
      circuitOpenDurationMs: parseIntInRange(
        process.env.CIRCUIT_BREAKER_OPEN_DURATION_MS,
        10_000,
        100,
        300_000,
        'CIRCUIT_BREAKER_OPEN_DURATION_MS',
      ),
      circuitHalfOpenMaxRequests: parseIntInRange(
        process.env.CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS,
        1,
        1,
        10,
        'CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS',
      ),
      eventsCapacity: parseIntInRange(
        process.env.EVENTS_CAPACITY,
        2_000,
        10,
        100_000,
        'EVENTS_CAPACITY',
      ),
      metricsLatencyWindow: parseIntInRange(
        process.env.METRICS_LATENCY_WINDOW,
        200,
        10,
        100_000,
        'METRICS_LATENCY_WINDOW',
      ),
      incidentFailureThreshold: parseIntInRange(
        process.env.INCIDENT_FAILURE_THRESHOLD,
        3,
        1,
        100,
        'INCIDENT_FAILURE_THRESHOLD',
      ),
      incidentLookbackMs: parseIntInRange(
        process.env.INCIDENT_LOOKBACK_MS,
        60_000,
        1_000,
        3_600_000,
        'INCIDENT_LOOKBACK_MS',
      ),
      incidentRecoveryQuietMs: parseIntInRange(
        process.env.INCIDENT_RECOVERY_QUIET_MS,
        10_000,
        0,
        3_600_000,
        'INCIDENT_RECOVERY_QUIET_MS',
      ),
      incidentMaxResolved: parseIntInRange(
        process.env.INCIDENT_MAX_RESOLVED,
        100,
        1,
        10_000,
        'INCIDENT_MAX_RESOLVED',
      ),
      anomalyWindowSize: parseIntInRange(
        process.env.ANOMALY_WINDOW_SIZE,
        30,
        5,
        500,
        'ANOMALY_WINDOW_SIZE',
      ),
      anomalyMinSamples: parseIntInRange(
        process.env.ANOMALY_MIN_SAMPLES,
        10,
        2,
        100,
        'ANOMALY_MIN_SAMPLES',
      ),
      anomalySampleIntervalMs: parseIntInRange(
        process.env.ANOMALY_SAMPLE_INTERVAL_MS,
        5_000,
        200,
        600_000,
        'ANOMALY_SAMPLE_INTERVAL_MS',
      ),
      anomalyScoreWarning: parseFloat(
        process.env.ANOMALY_SCORE_WARNING || '0.5',
      ),
      anomalyScoreAnomalous: parseFloat(
        process.env.ANOMALY_SCORE_ANOMALOUS || '0.8',
      ),
    };
    if (
      !(
        config.anomalyScoreWarning > 0 &&
        config.anomalyScoreWarning < config.anomalyScoreAnomalous &&
        config.anomalyScoreAnomalous <= 1
      )
    ) {
      throw new Error(
        'Invalid ANOMALY_SCORE_* thresholds — require 0 < WARNING < ANOMALOUS <= 1.',
      );
    }
    if (config.anomalyMinSamples > config.anomalyWindowSize) {
      throw new Error(
        'Invalid ANOMALY_MIN_SAMPLES — must not exceed ANOMALY_WINDOW_SIZE.',
      );
    }
    return config;
  } catch (error) {
    console.error(`[config] Environment validation failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

export const env: Env = loadEnv();
