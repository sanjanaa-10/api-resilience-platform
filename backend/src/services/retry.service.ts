import type { RetryAttemptRecord, RetryPolicyConfig } from '../types';
import { isIdempotentMethod } from './retryPolicy.service';

/** Verdict returned by the caller-supplied classifier for one attempt. */
export interface RetryDecision {
  /** True when the failure looks transient and another attempt is worthwhile. */
  retryable: boolean;
  /** Stable machine-readable label, e.g. 'SUCCESS' | 'TIMEOUT' | 'HTTP_503'. */
  outcome: string;
  /** Upstream HTTP status when one was observed (for logging only). */
  observedStatus?: number;
}

export interface RetryExecutionResult<T> {
  value: T;
  /** Total attempts made, INCLUDING the initial request. */
  attempts: number;
  /** retries = attempts - 1 (0 when the first attempt succeeded). */
  retries: number;
  /** Wall-clock time spent across ALL attempts plus backoff waits. */
  totalDurationMs: number;
  attemptsLog: RetryAttemptRecord[];
}

export interface ExecuteWithRetryOptions<T> {
  /** One attempt. Receives the 1-based attempt number. Must honor its own per-attempt timeout. */
  operation: (attempt: number) => Promise<T>;
  /** Pure classifier: decides whether `value` represents a retryable failure. */
  decide: (value: T) => RetryDecision;
  policy: RetryPolicyConfig;
  /**
   * Request-safety guard: only idempotent methods may be replayed.
   * Retrying a POST blindly risks duplicate side effects (double charges,
   * duplicate orders) because a timeout does NOT tell you whether the
   * server processed the request before the connection died.
   */
  method?: string;
  /**
   * Total-budget guard (wall-clock ceiling for the whole loop). Distinct
   * from the per-attempt timeout: each attempt bounds ITSELF, while this
   * bounds attempts + backoff combined, protecting against runaway configs.
   */
  totalBudgetMs?: number;
  onAttempt?: (record: RetryAttemptRecord) => void;
}

/** Asynchronous delay — never blocks the Node.js event loop. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with equal jitter:
 *   capped  = min(baseDelayMs * 2^(failedAttempt-1), maxDelayMs)
 *   actual  = capped/2 + random(0, capped/2)
 *
 * WHY JITTER: without randomness, every client that fails at the same
 * moment (deploy restart, dependency blip) also retries at the same moment,
 * synchronizing their load into a retry storm that re-triggers the outage.
 * Bounded randomization desynchronizes clients while keeping growth
 * exponential. "Equal" jitter splits the band in half (fixed floor +
 * random remainder) so successive attempt ranges stay non-overlapping —
 * predictable, and verifiable in tests.
 */
export function computeBackoffDelayMs(policy: RetryPolicyConfig, failedAttempt: number): number {
  const raw = policy.baseDelayMs * Math.pow(2, failedAttempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/**
 * Generic retry executor. Knows NOTHING about HTTP — the caller classifies
 * outcomes; this module only owns loop mechanics: attempt counting,
 * backoff scheduling, safety guards, and observability hooks.
 */
export async function executeWithRetry<T>(
  options: ExecuteWithRetryOptions<T>,
): Promise<RetryExecutionResult<T>> {
  const { operation, decide, policy, method, totalBudgetMs, onAttempt } = options;
  const retriesAllowed = method === undefined || isIdempotentMethod(method);

  const startedAt = Date.now();
  const attemptsLog: RetryAttemptRecord[] = [];
  let attempt = 0;
  let retries = 0;
  let finalValue: T;

  for (;;) {
    attempt += 1;
    finalValue = await operation(attempt);

    const decision = decide(finalValue);
    const attemptsUsedUp = attempt >= policy.maxAttempts;
    const budgetExhausted =
      totalBudgetMs !== undefined && Date.now() - startedAt >= totalBudgetMs;
    const willRetry =
      decision.retryable && !attemptsUsedUp && retriesAllowed && !budgetExhausted;

    const record: RetryAttemptRecord = {
      attempt,
      outcome: decision.outcome,
      status: decision.observedStatus ?? null,
      retried: willRetry,
      ...(willRetry
        ? { retryReason: decision.outcome, delayMs: computeBackoffDelayMs(policy, attempt) }
        : {}),
    };
    attemptsLog.push(record);
    onAttempt?.(record);

    if (!willRetry) break;

    retries += 1;
    await sleep(record.delayMs as number);
  }

  return {
    value: finalValue,
    attempts: attempt,
    retries,
    totalDurationMs: Date.now() - startedAt,
    attemptsLog,
  };
}
