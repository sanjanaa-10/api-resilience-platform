import { Router } from 'express';
import { PROVIDER_GROUPS } from '../config/services.config';
import { env } from '../config/env';
import { createGroupProxyHandler } from '../controllers/gateway.controller';
import type { CircuitBreaker } from '../services/circuitBreaker.service';
import type { HealthMonitor } from '../services/healthMonitor.service';

export interface ProxyRoutesDependencies {
  circuitBreaker: CircuitBreaker;
  healthMonitor: HealthMonitor;
}

/**
 * Proxy surface — one route per PROVIDER GROUP, all backed by the SAME
 * handler factory and failover-aware proxy mechanism. Adding an upstream
 * to a group (or adding a whole new group) automatically extends routing.
 */
export function createProxyRoutes(dependencies: ProxyRoutesDependencies): Router {
  const router = Router();

  const retryPolicy = {
    maxAttempts: env.retryMaxAttempts,
    baseDelayMs: env.retryBaseDelayMs,
    maxDelayMs: env.retryMaxDelayMs,
  };

  for (const group of PROVIDER_GROUPS) {
    router.get(
      `${group.gatewayPath}/test`,
      createGroupProxyHandler(group, {
        timeoutMs: env.upstreamTimeoutMs,
        retryPolicy,
        retryTotalBudgetMs: env.retryTotalBudgetMs,
        circuitBreaker: dependencies.circuitBreaker,
        healthMonitor: dependencies.healthMonitor,
      }),
    );
  }

  return router;
}
