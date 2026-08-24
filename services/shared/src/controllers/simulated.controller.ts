import type { RequestHandler } from 'express';
import type {
  SimulationContext,
  SimulatedFailureBody,
  SimulatedSuccessBody,
} from '../types';

/**
 * The realistic business endpoint shared by all services
 * (e.g. GET /api/payments/test). Runs one engine turn and renders the
 * matching envelope: success payload, controlled 500, or offline 503.
 */
export function createSimulatedTestHandler<TData>(
  context: SimulationContext<TData>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const requestId = req.requestId;
      const outcome = await context.engine.performRequest();

      const base = {
        service: context.definition.name,
        requestId,
        timestamp: new Date().toISOString(),
        simulatedLatencyMs: outcome.latencyMs,
      };

      if (outcome.kind === 'offline') {
        const body: SimulatedFailureBody = {
          ...base,
          status: 'offline',
          error: {
            code: 'SIMULATED_OFFLINE',
            message: `${context.definition.name} is currently offline (simulation).`,
          },
        };
        res.status(503).json(body);
        return;
      }

      if (outcome.kind === 'error') {
        const failureStatus = context.engine.getConfig().failureStatus ?? 500;
        const body: SimulatedFailureBody = {
          ...base,
          status: 'error',
          error: {
            code: 'SIMULATED_FAILURE',
            message: `${context.definition.name} failed while processing the request (simulated).`,
          },
        };
        res.status(failureStatus).json(body);
        return;
      }

      const body: SimulatedSuccessBody<TData> = {
        ...base,
        status: 'success',
        data: context.definition.buildPayload({ requestId }),
      };
      res.status(200).json(body);
    } catch (error) {
      next(error);
    }
  };
}
