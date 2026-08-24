import type { RequestHandler } from 'express';
import type { SimulationContext } from '../types';
import { ApiError } from '../utils/ApiError';
import { validateSimulationPatch } from '../utils/validateSimulationConfig';

/** GET /simulation/state — current knobs + lifetime counters. */
export function createGetStateHandler(context: SimulationContext): RequestHandler {
  return (_req, res) => {
    res.status(200).json(context.engine.getState());
  };
}

/**
 * POST /simulation/config — merges a strictly validated partial patch.
 * Invalid input yields a 400 envelope with per-field errors; it never
 * throws past the validation layer, so the server cannot be crashed by
 * malformed chaos commands.
 */
export function createConfigureHandler(context: SimulationContext): RequestHandler {
  return (req, res, next) => {
    try {
      const result = validateSimulationPatch(req.body);
      if (!result.ok) {
        throw ApiError.badRequest('Invalid simulation configuration.', { errors: result.errors });
      }
      res.status(200).json(context.engine.applyPatch(result.patch));
    } catch (error) {
      next(error);
    }
  };
}

/** POST /simulation/reset — restores defaults and zeroes counters. */
export function createResetHandler(context: SimulationContext): RequestHandler {
  return (_req, res) => {
    res.status(200).json(context.engine.reset());
  };
}
