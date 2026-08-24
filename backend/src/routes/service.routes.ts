import { Router } from 'express';
import {
  createListServicesHandler,
  createRefreshServicesHandler,
} from '../controllers/gateway.controller';
import type { HealthMonitor } from '../services/healthMonitor.service';
import type { CircuitBreaker } from '../services/circuitBreaker.service';

export interface ServiceRoutesDependencies {
  healthMonitor: HealthMonitor;
  circuitBreaker: CircuitBreaker;
}

/** Registry health + circuit surface: GET /services, POST /services/check (mounted at /api). */
export function createServiceRoutes(dependencies: ServiceRoutesDependencies): Router {
  const router = Router();

  router.get(
    '/services',
    createListServicesHandler(dependencies.healthMonitor, dependencies.circuitBreaker),
  );
  router.post('/services/check', createRefreshServicesHandler(dependencies.healthMonitor));

  return router;
}
