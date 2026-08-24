import { env } from '../config/env';
import type { LogLevel } from '../types';

interface LogContext {
  [key: string]: unknown;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Minimal structured JSON logger — zero dependencies.
 * Emits one JSON object per line so log aggregators (ELK, Datadog, Loki)
 * can index fields directly. This is the foundation of the observability pillar.
 */
function write(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[env.logLevel]) return;

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: env.serviceName,
    message,
    ...(context !== undefined ? { context } : {}),
  };
  const serialized = JSON.stringify(entry);

  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const logger = {
  debug: (message: string, context?: LogContext): void => write('debug', message, context),
  info: (message: string, context?: LogContext): void => write('info', message, context),
  warn: (message: string, context?: LogContext): void => write('warn', message, context),
  error: (message: string, context?: LogContext): void => write('error', message, context),
};

export type Logger = typeof logger;
