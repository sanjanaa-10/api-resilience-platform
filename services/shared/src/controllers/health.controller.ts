import type { RequestHandler } from 'express';
import type { HealthResult, SimulationContext } from '../types';

/**
 * GET /health — liveness probe that reflects simulation state:
 * `unhealthy` while the service is switched offline, so the future gateway's
 * health checker and dashboard topology react to chaos commands in real time.
 */
export function createHealthHandler(context: SimulationContext): RequestHandler {
  return (_req, res) => {
    const config = context.engine.getConfig();
    const body: HealthResult = {
      service: context.definition.name,
      status: config.online ? 'healthy' : 'unhealthy',
      latencyMs: config.latencyMs,
      timestamp: new Date().toISOString(),
    };
    res.status(200).json(body);
  };
}
