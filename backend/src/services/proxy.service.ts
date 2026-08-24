import type {
  ProxyBusinessResult,
  ProxyOutcome,
  RetryAttemptRecord,
  RetryPolicyConfig,
  ServiceRegistration,
} from '../types';
import { callUpstream, tryParseJson } from './upstreamClient.service';
import { executeWithRetry, type RetryDecision } from './retry.service';
import { isRetryableHttpStatus } from './retryPolicy.service';
import { logger } from '../utils/logger';

// Canonical definitions live in types/index.ts; re-exported so existing
// consumers can keep importing them alongside the proxy mechanism.
export type { ProxyBusinessResult, ProxyOutcome, ProxyRetryStats } from '../types';

export interface ProxyRequestOptions {
  requestId: string;
  /** Per-attempt timeout — every attempt bounds itself independently. */
  timeoutMs: number;
  retryPolicy: RetryPolicyConfig;
  /** Wall-clock ceiling for the whole loop (attempts + backoff combined). */
  retryTotalBudgetMs?: number;
  /**
   * Real-time per-attempt hook (fires the moment an attempt finishes, not
   * after the loop). Used by observability for RETRY_ATTEMPT / UPSTREAM_TIMEOUT
   * events. Failures are swallowed: proxying must never break on telemetry.
   */
  onAttemptRecord?: (record: RetryAttemptRecord) => void;
}

function extractUpstreamRequestId(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'requestId' in body) {
    const value = (body as { requestId: unknown }).requestId;
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * Retry classification for one finished attempt.
 *
 * RETRY:    network failures, timeouts, HTTP 502/503/504 (transient).
 * NO RETRY: any 4xx (client errors repeat identically), other 5xx
 *           (usually deterministic bugs), invalid responses
 *           (conservative default — could be a permanent contract break).
 */
function decideFromOutcome(outcome: ProxyOutcome): RetryDecision {
  switch (outcome.kind) {
    case 'success':
      return { retryable: false, outcome: 'SUCCESS', observedStatus: outcome.status };
    case 'upstream-error':
      return {
        retryable: isRetryableHttpStatus(outcome.status),
        outcome: `HTTP_${outcome.status}`,
        observedStatus: outcome.status,
      };
    case 'timeout':
      return { retryable: true, outcome: 'TIMEOUT' };
    case 'unreachable':
      return { retryable: true, outcome: 'NETWORK_ERROR' };
    case 'invalid-response':
      return { retryable: false, outcome: 'INVALID_RESPONSE', observedStatus: outcome.status };
  }
}

/**
 * Public-safe metadata only. Internal details (delays, per-retry reasons)
 * stay in logs — API consumers learn THAT a retry happened, not how.
 */
function withRetryMetadata(body: unknown, attempts: number, retries: number): unknown {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), retry: { attempts, retries } };
  }
  return body;
}

/**
 * The ONE reusable proxy mechanism — every registered service is proxied
 * through this function, driven purely by its registry entry, now wrapped
 * in the generic retry executor.
 *
 * Timeout layering:
 *   - each attempt carries its own AbortSignal.timeout(timeoutMs) covering
 *     connection + headers + full body read;
 *   - retryTotalBudgetMs bounds attempts + backoff COMBINED so a
 *     misconfigured policy cannot produce unbounded wall-clock time.
 */
export async function proxyBusinessRequest(
  entry: ServiceRegistration,
  options: ProxyRequestOptions,
): Promise<ProxyBusinessResult> {
  const url = `${entry.baseUrl}${entry.targetPath}`;

  async function attemptOnce(): Promise<ProxyOutcome> {
    const result = await callUpstream(url, {
      headers: { accept: 'application/json', 'x-request-id': options.requestId },
      timeoutMs: options.timeoutMs,
    });

    switch (result.kind) {
      case 'timeout':
        return { kind: 'timeout', durationMs: result.durationMs };
      case 'network-error':
        return { kind: 'unreachable', durationMs: result.durationMs, errorMessage: result.errorMessage };
    }

    const parsed = tryParseJson(result.bodyText);
    if (!parsed.ok) {
      return {
        kind: 'invalid-response',
        status: result.status,
        durationMs: result.durationMs,
        bodySnippet: result.bodyText.slice(0, 200),
      };
    }

    const upstreamRequestId = extractUpstreamRequestId(parsed.value);

    if (result.status >= 200 && result.status < 300) {
      return {
        kind: 'success',
        status: result.status,
        body: parsed.value,
        durationMs: result.durationMs,
        upstreamRequestId,
      };
    }

    return {
      kind: 'upstream-error',
      status: result.status,
      body: parsed.value,
      durationMs: result.durationMs,
      upstreamRequestId,
    };
  }

  const execution = await executeWithRetry<ProxyOutcome>({
    operation: attemptOnce,
    decide: decideFromOutcome,
    policy: options.retryPolicy,
    // Request safety: these test endpoints are GET; unsafe methods would
    // never be retried until idempotency keys exist.
    method: 'GET',
    totalBudgetMs: options.retryTotalBudgetMs,
    onAttempt: (record) => {
      logger.info('proxy_attempt', {
        requestId: options.requestId,
        service: entry.name,
        attempt: record.attempt,
        status: record.status,
        outcome: record.outcome,
        retry: record.retried,
        retryReason: record.retryReason,
        delayMs: record.delayMs,
      });

      if (options.onAttemptRecord !== undefined) {
        try {
          options.onAttemptRecord(record);
        } catch (error) {
          logger.warn('proxy_observer_error', { errorMessage: (error as Error).message });
        }
      }
    },
  });

  if (execution.value.kind === 'success' && execution.retries > 0) {
    execution.value.body = withRetryMetadata(
      execution.value.body,
      execution.attempts,
      execution.retries,
    );
  }

  return {
    outcome: execution.value,
    retry: {
      attempts: execution.attempts,
      retries: execution.retries,
      totalDurationMs: execution.totalDurationMs,
      attemptsLog: execution.attemptsLog,
    },
  };
}
