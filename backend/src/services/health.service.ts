import { env } from '../config/env';
import type { HealthCheckResult } from '../types';

/**
 * Business logic for service health. Today it reports liveness of this
 * process; later phases extend this to probe downstream APIs, feed the
 * circuit breakers and drive the dashboard's live topology view.
 */
export function getHealth(): HealthCheckResult {
  return {
    status: 'ok',
    service: env.serviceName,
  };
}

export const healthService = { getHealth } as const;
