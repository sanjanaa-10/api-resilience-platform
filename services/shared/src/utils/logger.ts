import type { LogLevel } from '../types';

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinWeight(): number {
  const raw = process.env.LOG_LEVEL;
  if (raw === 'debug' || raw === 'warn' || raw === 'error') return LEVEL_WEIGHT[raw];
  return LEVEL_WEIGHT.info;
}

/**
 * Structured JSON logger (one object per line) tagged with the service name,
 * matching the logging format used across the whole platform so log
 * aggregators can index every component uniformly.
 */
export function createLogger(serviceName: string): Logger {
  const minWeight = resolveMinWeight();

  function write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_WEIGHT[level] < minWeight) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      service: serviceName,
      message,
      ...(context !== undefined ? { context } : {}),
    };
    const serialized = JSON.stringify(entry);

    if (level === 'error') console.error(serialized);
    else if (level === 'warn') console.warn(serialized);
    else console.log(serialized);
  }

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}
