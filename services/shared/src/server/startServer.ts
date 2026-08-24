import http from 'node:http';
import type { Express } from 'express';
import type { ServiceDefinition } from '../types';
import { createLogger } from '../utils/logger';

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Binds the app to the service's fixed port and installs lifecycle handlers
 * (signals, graceful shutdown, crash guards) — the same discipline as the
 * main backend, applied to every simulator process.
 */
export function startSimulationServer(app: Express, definition: ServiceDefinition): http.Server {
  const logger = createLogger(definition.name);

  const server = http.createServer(app);

  server.listen(definition.port, () => {
    logger.info('server_started', {
      port: definition.port,
      url: `http://localhost:${definition.port}`,
      testEndpoint: definition.testEndpointPath,
    });
  });

  const shutdown = (signal: string): void => {
    logger.warn('server_shutdown_initiated', { signal });

    server.close((error) => {
      if (error !== undefined) {
        logger.error('server_shutdown_forced', { reason: error.message });
        process.exit(1);
      }
      logger.info('server_shutdown_complete');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('server_shutdown_timeout');
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled_rejection', {
      reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught_exception', { errorMessage: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });

  return server;
}
