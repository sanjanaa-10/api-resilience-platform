import type {
  FailoverAttemptRecord,
  FailoverExecution,
  FailoverMetadata,
  FailoverReason,
  ProviderGroup,
  ProxyBusinessResult,
  ProxyOutcome,
  RetryPolicyConfig,
  ServiceName,
  ServiceRegistration,
} from '../types';
import { countsAsCircuitFailure, type CircuitBreaker } from './circuitBreaker.service';
import type { ProxyRequestOptions } from './proxy.service';
import { logger } from '../utils/logger';

/** Failover budget per logical request: primary + at most ONE fallback. */
export const DEFAULT_MAX_FAILOVERS = 1;

/** Payload mirrored into the resilience event stream by the orchestrator. */
export interface FailoverEmission {
  eventType: 'FAILOVER_STARTED' | 'FAILOVER_COMPLETED';
  group: string;
  primaryProvider: ServiceName;
  requestId: string;
  /** STARTED only — why traffic left the primary. */
  reason?: FailoverReason | null;
  /** COMPLETED only — the provider that ultimately served. */
  selectedProvider?: ServiceName | null;
}

/**
 * Optional observability hook. Failures inside it must never affect
 * orchestration; the composition root wraps its own try/catch as well.
 */
export type FailoverEventEmitter = (emission: FailoverEmission) => void;

export interface FailoverDeps {
  circuitBreaker: CircuitBreaker;
  /** Strict health gate for fallback selection (monitor-backed). */
  isProviderHealthy(name: ServiceName): boolean;
  /** Overridable for tests; production keeps the default budget of 1. */
  maxFailovers?: number;
  /** Optional event-stream hook for FAILOVER_STARTED / COMPLETED. */
  emit?: FailoverEventEmitter;
}

export interface FailoverRequestContext {
  requestId: string;
  timeoutMs: number;
  retryPolicy: RetryPolicyConfig;
  retryTotalBudgetMs?: number;
}

/**
 * The per-provider execution mechanism, injected so tests can substitute
 * canned outcomes. Production passes proxyBusinessRequest directly.
 */
export type ProviderExecutor = (
  entry: ServiceRegistration,
  options: ProxyRequestOptions,
) => Promise<ProxyBusinessResult>;

/**
 * Should this final provider outcome trigger trying the next provider?
 *
 * YES: timeout, network failure, HTTP 502/503/504 — transient conditions
 *      another equivalent provider can plausibly survive.
 * NO:  4xx (client errors repeat identically), other 5xx (usually
 *      deterministic bugs — never blindly fail over every 5xx),
 *      malformed responses (possible permanent contract break).
 *
 * Deliberately a separate classifier from countsAsCircuitFailure even though
 * the status sets coincide today: the circuit asks "did this hurt the
 * dependency?", failover asks "could an equivalent provider do better?".
 * Coupling them would make future policy changes leak across concerns.
 */
export function isFailoverEligible(outcome: ProxyOutcome): boolean {
  switch (outcome.kind) {
    case 'timeout':
    case 'unreachable':
      return true;
    case 'upstream-error':
      return outcome.status === 502 || outcome.status === 503 || outcome.status === 504;
    default:
      return false;
  }
}

function failoverReasonFromOutcome(outcome: ProxyOutcome): FailoverReason | null {
  switch (outcome.kind) {
    case 'timeout':
      return 'UPSTREAM_TIMEOUT';
    case 'unreachable':
      return 'NETWORK_UNAVAILABLE';
    case 'upstream-error':
      if (outcome.status === 502) return 'HTTP_502';
      if (outcome.status === 503) return 'HTTP_503';
      if (outcome.status === 504) return 'HTTP_504';
      return null;
    default:
      return null;
  }
}

/** Client-facing metadata derived from one execution. */
export function buildFailoverMetadata(execution: FailoverExecution): FailoverMetadata {
  return {
    occurred: execution.failoverOccurred,
    selectedProvider: execution.selectedProvider,
    ...(execution.failoverOccurred
      ? { primary: execution.primaryProvider, reason: execution.failoverReason ?? undefined }
      : {}),
  };
}

/**
 * Executes ONE logical request across a provider group.
 *
 * Invariants (all preserved by construction):
 *  - STRICTLY FORWARD iteration over group.providers — a request can never
 *    revisit a provider, so retry/failover loops are structurally impossible.
 *  - Exactly ONE rate-limit token per client request; everything here happens
 *    inside the same logical request started by the controller.
 *  - Each executed provider records exactly ONE circuit outcome after its own
 *    retry loop finishes. Providers skipped by admission/health/budget gates
 *    record NOTHING (rejections are not failures).
 *  - Budget: at most DEFAULT_MAX_FAILOVERS transitions past the primary,
 *    regardless of whether the primary failed by executing or by admission.
 *  - Health gate applies to FALLBACKS only: the primary is always offered to
 *    its circuit breaker even while its monitor snapshot is degraded, so a
 *    stale "unhealthy" probe can never silently bypass the primary.
 *  - failoverReason captures why we LEFT the primary and is never rewritten
 *    by later fallback outcomes.
 */
export async function executeWithFailover(
  group: ProviderGroup,
  request: FailoverRequestContext,
  executeProvider: ProviderExecutor,
  deps: FailoverDeps,
): Promise<FailoverExecution> {
  const startedAt = Date.now();
  const maxFailovers = deps.maxFailovers ?? DEFAULT_MAX_FAILOVERS;
  const [primary] = group.providers;
  if (primary === undefined) {
    throw new Error(`Provider group "${group.id}" declares no providers.`);
  }

  const attempts: FailoverAttemptRecord[] = [];
  let selectedProvider: ServiceName | null = null;
  let failoverReason: FailoverReason | null = null;
  let finalResult: ProxyBusinessResult | null = null;
  let primaryDurationMs: number | null = null;
  let fallbackDurationMs: number | null = null;
  let failoversUsed = 0;
  let startedEmitted = false;

  const emitStarted = (reason: FailoverReason): void => {
    if (startedEmitted || deps.emit === undefined) return;
    startedEmitted = true;
    try {
      deps.emit({
        eventType: 'FAILOVER_STARTED',
        group: group.id,
        primaryProvider: primary.name,
        requestId: request.requestId,
        reason,
      });
    } catch (error) {
      logger.warn('failover_observer_error', { errorMessage: (error as Error).message });
    }
  };

  for (const [index, entry] of group.providers.entries()) {
    const isPrimary = index === 0;

    // ── Gates for continuing onto a fallback ────────────────────────────
    // failoversUsed = transitions made so far. A budget of 1 permits exactly
    // one move off the primary, so the block condition is strictly greater.
    if (!isPrimary && failoversUsed > maxFailovers) {
      attempts.push({ provider: entry.name, attempted: false, skipReason: 'BUDGET_EXHAUSTED' });
      break;
    }
    if (!isPrimary && !deps.isProviderHealthy(entry.name)) {
      attempts.push({ provider: entry.name, attempted: false, skipReason: 'UNHEALTHY' });
      break;
    }

    // ── Circuit admission (fail fast BEFORE any upstream/retry work) ────
    const admission = deps.circuitBreaker.canRequest(entry.name, request.requestId);
    if (!admission.allowed) {
      attempts.push({ provider: entry.name, attempted: false, skipReason: 'CIRCUIT_OPEN' });
      logger.warn('circuit_fast_fail', {
        requestId: request.requestId,
        service: entry.name,
        state: admission.state,
        path: `${entry.baseUrl}${entry.targetPath}`,
        role: isPrimary ? 'primary' : 'fallback',
      });
      if (isPrimary) {
        failoverReason = 'CIRCUIT_OPEN';
        failoversUsed += 1; // leaving the primary consumes the budget too
        emitStarted('CIRCUIT_OPEN');
        continue;
      }
      break;
    }

    // ── Execute this provider's bounded retry loop ──────────────────────
    let result: ProxyBusinessResult;
    try {
      result = await executeProvider(entry, {
        requestId: request.requestId,
        timeoutMs: request.timeoutMs,
        retryPolicy: request.retryPolicy,
        retryTotalBudgetMs: request.retryTotalBudgetMs,
      });
    } catch (error) {
      // Admitted slot must not leak: count the crash as this provider's failure.
      deps.circuitBreaker.recordFailure(entry.name, request.requestId, 'proxy_crashed');
      throw error;
    }

    // ── Record FINAL outcome once — internal retries stay invisible ─────
    if (countsAsCircuitFailure(result.outcome)) {
      deps.circuitBreaker.recordFailure(entry.name, request.requestId);
    } else if (result.outcome.kind === 'success') {
      deps.circuitBreaker.recordSuccess(entry.name, request.requestId);
    }

    attempts.push({
      provider: entry.name,
      attempted: true,
      outcomeKind: result.outcome.kind,
    });

    if (isPrimary) primaryDurationMs = result.retry.totalDurationMs;
    else fallbackDurationMs = result.retry.totalDurationMs;

    finalResult = result;
    selectedProvider = entry.name;

    if (result.outcome.kind === 'success' || !isFailoverEligible(result.outcome)) {
      break; // served (or failed non-eligibly) — done, no failover
    }

    // Eligible failure: remember WHY we left the primary (never overwritten).
    if (failoverReason === null) {
      failoverReason = failoverReasonFromOutcome(result.outcome);
    }
    if (isPrimary && failoverReason !== null) emitStarted(failoverReason);
    failoversUsed += 1;
  }

  const totalDurationMs = Date.now() - startedAt;
  const failoverOccurred =
    selectedProvider !== null && selectedProvider !== primary.name;

  if (failoverOccurred && deps.emit !== undefined) {
    try {
      deps.emit({
        eventType: 'FAILOVER_COMPLETED',
        group: group.id,
        primaryProvider: primary.name,
        requestId: request.requestId,
        reason: failoverReason,
        selectedProvider,
      });
    } catch (error) {
      logger.warn('failover_observer_error', { errorMessage: (error as Error).message });
    }
  }

  const primaryAttempts = attempts.filter((a) => a.provider === primary.name && a.attempted).length;
  const fallbackAttempts = attempts.filter((a) => a.provider !== primary.name && a.attempted).length;

  const summaryEvent = {
    requestId: request.requestId,
    group: group.id,
    primaryProvider: primary.name,
    selectedProvider,
    failoverOccurred,
    ...(failoverOccurred ? { failoverReason } : {}),
    primaryDurationMs,
    fallbackDurationMs,
    totalDurationMs,
    primaryAttempts,
    fallbackAttempts,
    attempts: attempts.map((attempt) => ({
      provider: attempt.provider,
      attempted: attempt.attempted,
      ...(attempt.attempted
        ? { outcomeKind: attempt.outcomeKind }
        : { skipReason: attempt.skipReason }),
    })),
  };
  if (failoverOccurred) {
    logger.warn('proxy_failover', summaryEvent);
  } else {
    logger.info('proxy_failover_summary', summaryEvent);
  }

  return {
    primaryProvider: primary.name,
    outcome: finalResult?.outcome ?? null,
    retry: finalResult?.retry ?? null,
    selectedProvider,
    failoverOccurred,
    failoverReason: failoverOccurred ? failoverReason : null,
    attempts,
    primaryDurationMs,
    fallbackDurationMs,
    totalDurationMs,
  };
}
