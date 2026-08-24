import { Router, type Request, type RequestHandler } from 'express';
import { env } from '../config/env';
import type { ObservabilityService } from '../observability/observability.service';
import {
  EVENT_TYPES,
  isEventSeverity,
  isEventType,
  type EventSeverity,
  type EventType,
} from '../observability/events';
import { ApiError } from '../utils/ApiError';

export interface ObservabilityRoutesDependencies {
  observability: ObservabilityService;
}

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > env.eventsCapacity) {
    throw ApiError.badRequest(`Invalid limit "${raw}".`, {
      expected: `an integer between 1 and ${env.eventsCapacity}`,
    });
  }
  return value;
}

function requireEventType(raw: unknown): EventType | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value: unknown = raw.toUpperCase();
  if (!isEventType(value)) {
    throw ApiError.badRequest(`Unknown event type "${raw}".`, {
      allowed: EVENT_TYPES,
    });
  }
  return value;
}

function parseSeverity(raw: unknown): EventSeverity | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value: unknown = raw.toUpperCase();
  if (!isEventSeverity(value)) {
    throw ApiError.badRequest(`Unknown severity "${raw}".`, {
      allowed: ['INFO', 'WARNING', 'CRITICAL'],
    });
  }
  return value;
}

function parseService(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (value.length > 64) {
    throw ApiError.badRequest('service filter must be at most 64 characters.');
  }
  return value;
}

/** Wraps a handler so validation errors flow to the centralized error handler. */
function safe(handler: (req: Request) => unknown): RequestHandler {
  return (req, res, next) => {
    try {
      res.status(200).json(handler(req));
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Read-only observability surface. All state is derived from the in-memory
 * event store / metrics / incident aggregator — no side effects exist here.
 *
 * Route order matters: /incidents/active is registered BEFORE /incidents/:id
 * so "active" is never captured as an id.
 */
export function createObservabilityRoutes(dependencies: ObservabilityRoutesDependencies): Router {
  const router = Router();
  const { observability } = dependencies;

  router.get(
    '/metrics',
    safe(() => observability.getMetrics()),
  );

  router.get(
    '/events',
    safe((req) => {
      const events = observability.listEvents({
        service: parseService(req.query['service']),
        eventType: requireEventType(req.query['type']),
        severity: parseSeverity(req.query['severity']),
        limit: parseLimit(req.query['limit']),
      });
      return { count: events.length, events };
    }),
  );

  router.get(
    '/incidents/active',
    safe(() => {
      const incidents = observability.listActiveIncidents();
      return { count: incidents.length, incidents };
    }),
  );

  router.get(
    '/incidents/:id',
    safe((req) => {
      const rawId = req.params['id'];
      const id = Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? '');
      const incident = observability.getIncident(id);
      if (incident === null) {
        throw ApiError.notFound(`No incident found with id ${id}.`);
      }
      return incident;
    }),
  );

  router.get(
    '/incidents',
    safe(() => {
      const incidents = observability.listIncidents();
      return { count: incidents.length, incidents };
    }),
  );

  return router;
}
