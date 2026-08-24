import { Router, type Request, type RequestHandler } from 'express';
import type { AnomalyDetector } from '../anomaly/anomalyDetector.service';
import { ApiError } from '../utils/ApiError';

export interface AnomalyRoutesDependencies {
  anomalyDetector: AnomalyDetector;
}

/** Wraps a handler so unexpected failures flow to the centralized handler. */
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
 * Read-only anomaly surface over the detector's latest assessments:
 *   GET /api/anomalies                    -> every tracked service
 *   GET /api/anomalies/:service/history   -> bounded assessment history
 *   GET /api/anomalies/:service           -> full report w/ baseline + reasons
 * Route order matters: the literal collection route and :service/history are
 * registered before :service so neither is captured as an id.
 */
export function createAnomalyRoutes(dependencies: AnomalyRoutesDependencies): Router {
  const router = Router();
  const { anomalyDetector } = dependencies;

  router.get(
    '/anomalies',
    safe(() => {
      const anomalies = anomalyDetector.listReports();
      return { count: anomalies.length, anomalies };
    }),
  );

  router.get(
    '/anomalies/:service/history',
    safe((req) => {
      const raw = req.params['service'];
      const service = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
      if (anomalyDetector.statusOf(service) === null) {
        throw ApiError.notFound(`No anomaly history tracked for service "${service}".`);
      }
      const history = anomalyDetector.history(service);
      return { service, count: history.length, history };
    }),
  );

  router.get(
    '/anomalies/:service',
    safe((req) => {
      const raw = req.params['service'];
      const service = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
      const report = anomalyDetector.statusOf(service);
      if (report === null) {
        throw ApiError.notFound(`No anomaly report tracked for service "${service}".`);
      }
      return report;
    }),
  );

  return router;
}
