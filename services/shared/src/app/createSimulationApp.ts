import express from 'express';
import type { Express } from 'express';
import { createHealthHandler } from '../controllers/health.controller';
import { createSimulatedTestHandler } from '../controllers/simulated.controller';
import {
  createConfigureHandler,
  createGetStateHandler,
  createResetHandler,
} from '../controllers/simulation.controller';
import { createErrorHandler } from '../middleware/errorHandler.middleware';
import { createNotFoundHandler } from '../middleware/notFound.middleware';
import { createRequestLogger } from '../middleware/requestLogger.middleware';
import { SimulationEngine } from '../services/simulation.service';
import type { ServiceDefinition } from '../types';

/**
 * Builds a complete simulated upstream service from its definition.
 * Middleware order mirrors the main backend: parse -> log -> routes ->
 * notFound -> centralized error handler.
 */
export function createSimulationApp<TData>(
  definition: ServiceDefinition<TData>,
): { app: Express; engine: SimulationEngine } {
  const engine = new SimulationEngine(definition);
  const context = { definition, engine };

  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(createRequestLogger(definition.name));

  app.get('/health', createHealthHandler(context));

  app.get('/simulation/state', createGetStateHandler(context));
  app.post('/simulation/config', createConfigureHandler(context));
  app.post('/simulation/reset', createResetHandler(context));

  app.get(definition.testEndpointPath, createSimulatedTestHandler(context));

  app.use(createNotFoundHandler(definition.name));
  app.use(createErrorHandler(definition.name));

  return { app, engine };
}
