import type { RetryPolicyConfig } from '../types';

/**
 * Retry policy defaults. maxAttempts INCLUDES the initial request:
 *   attempt 1 = initial request
 *   attempt 2 = retry 1
 *   attempt 3 = retry 2
 * Overridable via RETRY_MAX_ATTEMPTS / RETRY_BASE_DELAY_MS / RETRY_MAX_DELAY_MS.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
};

/**
 * HTTP statuses considered TRANSIENT and therefore retryable:
 *   502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout —
 * the classic "the backend hiccuped, try again" codes.
 *
 * DELIBERATE POLICY on other 5xx (500 Internal Server Error, 501 Not
 * Implemented, ...): they are NOT retried. A 500 usually signals a
 * deterministic bug in the upstream — replaying the identical request
 * almost certainly produces the identical failure while adding load to an
 * already struggling service. This set makes that decision explicit and
 * evidence-driven: promoting a status to retryable is a one-line change.
 *
 * 4xx (400/401/403/404...) is NEVER retried: the client would receive the
 * same rejection every time; retrying only multiplies pointless traffic.
 */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

/**
 * Methods that cannot cause side effects are safe to replay blindly today.
 * Unsafe methods (POST/PUT/PATCH/DELETE) must remain single-attempt until
 * real idempotency support exists (idempotency keys, retry tokens) — a
 * network timeout does not reveal whether the server already executed the
 * operation before the response was lost.
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}
