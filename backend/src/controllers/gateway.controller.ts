import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type {
  FailoverMetadata,
  GatewayErrorCode,
  GatewayErrorBody,
  ProviderGroup,
  RetryPolicyConfig,
  ServiceName,
  ServicesOverviewWithCircuit,
} from '../types';
import { logger } from '../utils/logger';
import type { HealthMonitor } from '../services/healthMonitor.service';
import { proxyBusinessRequest } from '../services/proxy.service';
import type { ProxyOutcome } from '../services/proxy.service';
import {
  buildFailoverMetadata,
  executeWithFailover,
} from '../services/failover.service';
import type { CircuitBreaker } from '../services/circuitBreaker.service';

function buildGatewayError(
  code: GatewayErrorCode,
  message: string,
  statusCode: number,
  requestId: string | undefined,
  service: ServiceName,
  upstream?: Record<string, unknown>,
): GatewayErrorBody {
  return {
    success: false,
    error: {
      code,
      message,
      statusCode,
      ...(requestId !== undefined ? { requestId } : {}),
      service,
      ...(upstream !== undefined ? { upstream } : {}),
    },
  };
}

/**
 * GET /api/services — monitor snapshot for every registered provider
 * (including each member of a failover group), merged (at this route layer,
 * not inside the monitor) with the per-provider circuit breaker view.
 * Two deliberate lenses on one dependency:
 *   - health: "is the provider answering background probes?"
 *   - circuit: "is the breaker admitting live request traffic?"
 */
export function createListServicesHandler(
  healthMonitor: HealthMonitor,
  circuitBreaker: CircuitBreaker,
): RequestHandler {
  return (_req, res) => {
    const overview = healthMonitor.getOverview();
    const enriched: ServicesOverviewWithCircuit = {
      summary: overview.summary,
      services: overview.services.map((service) => ({
        ...service,
        circuit: circuitBreaker.snapshot(service.name),
      })),
    };
    res.status(200).json(enriched);
  };
}

/** POST /api/services/check — forces an immediate probing round. */
export function createRefreshServicesHandler(healthMonitor: HealthMonitor): RequestHandler {
  return async (_req, res, next) => {
    try {
      await healthMonitor.runRound();
      res.status(200).json(healthMonitor.getOverview());
    } catch (error) {
      next(error);
    }
  };
}

/** Success bodies gain a top-level failover block (plain objects only). */
function withFailoverMetadata(body: unknown, meta: FailoverMetadata): unknown {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), failover: meta };
  }
  return body;
}

/**
 * Factory producing ONE proxy handler per PROVIDER GROUP — payment and
 * notification are singleton groups (behavior identical to direct proxying);
 * the ai group carries a primary + fallback governed by the failover policy.
 *
 * Per logical request flow:
 *   rate limiter (middleware) -> executeWithFailover(group):
 *     primary admission check -> primary bounded retries -> on eligible
 *     failure/blocked admission: budget + health + circuit gates -> fallback
 *     bounded retries -> response (+failover metadata).
 *
 * Outcome mapping (unchanged semantics, applied to whichever provider served):
 *   success            -> upstream status + body passthrough (+failover meta)
 *   upstream-error 5xx -> same status, normalized gateway envelope
 *   timeout            -> 504 UPSTREAM_TIMEOUT
 *   unreachable        -> 503 UPSTREAM_UNAVAILABLE
 *   invalid-response   -> 502 UPSTREAM_INVALID_RESPONSE
 *   nothing attempted  -> 503 UPSTREAM_UNAVAILABLE (no eligible provider)
 */
export function createGroupProxyHandler(
  group: ProviderGroup,
  options: {
    timeoutMs: number;
    retryPolicy: RetryPolicyConfig;
    retryTotalBudgetMs?: number;
    circuitBreaker: CircuitBreaker;
    healthMonitor: HealthMonitor;
  },
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = req.requestId;
    try {
      const execution = await executeWithFailover(
        group,
        {
          requestId,
          timeoutMs: options.timeoutMs,
          retryPolicy: options.retryPolicy,
          retryTotalBudgetMs: options.retryTotalBudgetMs,
        },
        proxyBusinessRequest,
        {
          circuitBreaker: options.circuitBreaker,
          isProviderHealthy: (name) => options.healthMonitor.isHealthy(name),
        },
      );

      const logContext = {
        requestId,
        group: group.id,
        method: req.method,
        path: `${group.gatewayPath}/test`,
        selectedProvider: execution.selectedProvider,
        failoverOccurred: execution.failoverOccurred,
        ...(execution.failoverOccurred ? { failoverReason: execution.failoverReason } : {}),
        totalDurationMs: execution.totalDurationMs,
      };

      // ── Nothing could be attempted: the PRIMARY circuit rejected us and
      // every fallback (if any) was also gated. The root cause facing the
      // client is the primary's open circuit — same envelope as a plain
      // fail-fast, enriched with the per-provider skip trace.
      if (execution.outcome === null || execution.selectedProvider === null) {
        const primary = group.providers[0]?.name ?? ('unknown' as ServiceName);
        logger.warn('circuit_fast_fail', {
          requestId,
          group: group.id,
          service: primary,
          path: `${group.gatewayPath}/test`,
          reason: 'NO_ELIGIBLE_PROVIDER',
          attempts: execution.attempts,
        });
        res.status(503).json(
          buildGatewayError(
            'CIRCUIT_OPEN',
            `Circuit is open for upstream provider ${primary}.`,
            503,
            requestId,
            primary,
            { reason: 'NO_ELIGIBLE_PROVIDER', attempts: execution.attempts },
          ),
        );
        return;
      }

      const outcome: ProxyOutcome = execution.outcome;
      const servingProvider = execution.selectedProvider;

      switch (outcome.kind) {
        case 'success': {
          logger.info('proxy_request', {
            ...logContext,
            upstreamStatus: outcome.status,
            statusCode: outcome.status,
            durationMs: outcome.durationMs,
            upstreamRequestId: outcome.upstreamRequestId,
            attempts: execution.retry?.attempts,
            retries: execution.retry?.retries,
          });
          res.status(outcome.status).json(
            withFailoverMetadata(outcome.body, buildFailoverMetadata(execution)),
          );
          return;
        }
        case 'upstream-error': {
          const code =
            outcome.status === 503 ? ('UPSTREAM_UNAVAILABLE' as const) : ('UPSTREAM_ERROR' as const);
          logger.warn('proxy_upstream_error', {
            ...logContext,
            upstreamStatus: outcome.status,
            statusCode: outcome.status,
            durationMs: outcome.durationMs,
            upstreamRequestId: outcome.upstreamRequestId,
            attempts: execution.retry?.attempts,
            retries: execution.retry?.retries,
          });
          res.status(outcome.status).json(
            buildGatewayError(
              code,
              `Upstream ${servingProvider} responded with HTTP ${outcome.status}.`,
              outcome.status,
              requestId,
              servingProvider,
              {
                status: outcome.status,
                body: outcome.body,
                requestId: outcome.upstreamRequestId,
                durationMs: outcome.durationMs,
                retry: {
                  attempts: execution.retry?.attempts ?? 0,
                  retries: execution.retry?.retries ?? 0,
                },
                ...(execution.failoverOccurred
                  ? { failover: buildFailoverMetadata(execution) }
                  : {}),
              },
            ),
          );
          return;
        }
        case 'timeout': {
          logger.warn('upstream_timeout', {
            ...logContext,
            statusCode: 504,
            timeoutMs: options.timeoutMs,
            durationMs: outcome.durationMs,
            attempts: execution.retry?.attempts,
            retries: execution.retry?.retries,
          });
          res.status(504).json(
            buildGatewayError(
              'UPSTREAM_TIMEOUT',
              `Upstream ${servingProvider} did not respond within ${options.timeoutMs}ms.`,
              504,
              requestId,
              servingProvider,
              {
                timeoutMs: options.timeoutMs,
                durationMs: outcome.durationMs,
                retry: {
                  attempts: execution.retry?.attempts ?? 0,
                  retries: execution.retry?.retries ?? 0,
                },
                ...(execution.failoverOccurred
                  ? { failover: buildFailoverMetadata(execution) }
                  : {}),
              },
            ),
          );
          return;
        }
        case 'unreachable': {
          logger.warn('upstream_unreachable', {
            ...logContext,
            statusCode: 503,
            durationMs: outcome.durationMs,
            error: outcome.errorMessage,
            attempts: execution.retry?.attempts,
            retries: execution.retry?.retries,
          });
          res.status(503).json(
            buildGatewayError(
              'UPSTREAM_UNAVAILABLE',
              `Upstream ${servingProvider} is unavailable.`,
              503,
              requestId,
              servingProvider,
              {
                reason: outcome.errorMessage,
                durationMs: outcome.durationMs,
                retry: {
                  attempts: execution.retry?.attempts ?? 0,
                  retries: execution.retry?.retries ?? 0,
                },
                ...(execution.failoverOccurred
                  ? { failover: buildFailoverMetadata(execution) }
                  : {}),
              },
            ),
          );
          return;
        }
        case 'invalid-response': {
          logger.error('upstream_invalid_response', {
            ...logContext,
            upstreamStatus: outcome.status,
            statusCode: 502,
            durationMs: outcome.durationMs,
            bodySnippet: outcome.bodySnippet,
            attempts: execution.retry?.attempts,
            retries: execution.retry?.retries,
          });
          res.status(502).json(
            buildGatewayError(
              'UPSTREAM_INVALID_RESPONSE',
              `Upstream ${servingProvider} returned a malformed response.`,
              502,
              requestId,
              servingProvider,
              { upstreamStatus: outcome.status },
            ),
          );
          return;
        }
      }
    } catch (error) {
      next(error); // absolutely nothing may crash the gateway on an upstream failure
    }
  };
}
