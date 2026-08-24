import { Router } from 'express';
import { env } from '../config/env';
import { PROVIDER_GROUPS } from '../config/services.config';
import type { ServiceMetaResult } from '../types';
import { createProxyRoutes, type ProxyRoutesDependencies } from './proxy.routes';
import { createServiceRoutes, type ServiceRoutesDependencies } from './service.routes';
import {
  createObservabilityRoutes,
  type ObservabilityRoutesDependencies,
} from './observability.routes';
import { createAnomalyRoutes, type AnomalyRoutesDependencies } from './anomaly.routes';
import { healthRouter } from './health.routes';

export type ApiRouterDependencies = ServiceRoutesDependencies &
  ProxyRoutesDependencies &
  ObservabilityRoutesDependencies &
  AnomalyRoutesDependencies;

/**
 * Composition point for all route modules.
 * Future modules (chaos controls, admin surface) plug in here.
 */
export function createApiRouter(dependencies: ApiRouterDependencies): Router {
  const apiRouter = Router();

  const proxyEndpoints: Record<string, string> = {};
  for (const group of PROVIDER_GROUPS) {
    proxyEndpoints[group.id] = `/api${group.gatewayPath}/test`;
  }

  apiRouter.get('/', (_req, res) => {
    const meta: ServiceMetaResult = {
      service: env.serviceName,
      version: '0.9.0',
      description: 'API Resilience & Failover Platform — API Gateway',
      endpoints: {
        health: '/health',
        services: '/api/services',
        serviceCheck: '/api/services/check',
        metrics: '/api/metrics',
        events: '/api/events',
        incidents: '/api/incidents',
        anomalies: '/api/anomalies',
        ...proxyEndpoints,
      },
    };
    res.status(200).json(meta);
  });

  apiRouter.use('/health', healthRouter);
  apiRouter.use('/api', createServiceRoutes(dependencies));
  apiRouter.use('/api', createProxyRoutes(dependencies));
  apiRouter.use(
    '/api',
    createAnomalyRoutes({ anomalyDetector: dependencies.anomalyDetector }),
  );
  apiRouter.use(
    '/api',
    createObservabilityRoutes({ observability: dependencies.observability }),
  );

  return apiRouter;
}
