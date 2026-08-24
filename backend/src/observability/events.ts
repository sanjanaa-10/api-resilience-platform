import { randomUUID } from 'node:crypto';

/**
 * The closed vocabulary of resilience signals. Every layer emits ONLY these
 * types, so consumers (metrics, incidents) can rely on an exact union —
 * adding a new signal is a compile-time-checked change.
 */
export type EventType =
  | 'REQUEST_STARTED'
  | 'REQUEST_COMPLETED'
  | 'REQUEST_FAILED'
  | 'RETRY_ATTEMPT'
  | 'RATE_LIMITED'
  | 'CIRCUIT_OPENED'
  | 'CIRCUIT_HALF_OPEN'
  | 'CIRCUIT_CLOSED'
  | 'FAILOVER_STARTED'
  | 'FAILOVER_COMPLETED'
  | 'UPSTREAM_TIMEOUT'
  | 'HEALTH_CHANGED'
  | 'ANOMALY_DETECTED'
  | 'ANOMALY_RESOLVED';

export type EventSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/** One immutable resilience observation. Events are append-only facts. */
export interface ResilienceEvent {
  eventId: string;
  /** ISO-8601 UTC timestamp assigned at creation. */
  timestamp: string;
  eventType: EventType;
  /**
   * Owning service key. Provider names ('payment', 'ai-primary', ...)
   * for upstream events; 'gateway' for platform-level signals (rate limit).
   */
  service: string;
  severity: EventSeverity;
  /** Logical gateway request this event belongs to; null when not request-scoped. */
  requestId: string | null;
  message: string;
  /** Free-form structured payload (status codes, durations, reasons...). */
  metadata: Record<string, unknown>;
}

export interface EventInput {
  eventType: EventType;
  service: string;
  message: string;
  requestId?: string | null;
  severity?: EventSeverity;
  metadata?: Record<string, unknown>;
}

/**
 * Deterministic default severities per type. Callers may override
 * explicitly where direction matters (e.g. HEALTH_CHANGED to unhealthy).
 */
const DEFAULT_SEVERITY: Record<EventType, EventSeverity> = {
  REQUEST_STARTED: 'INFO',
  REQUEST_COMPLETED: 'INFO',
  REQUEST_FAILED: 'WARNING',
  RETRY_ATTEMPT: 'WARNING',
  RATE_LIMITED: 'WARNING',
  CIRCUIT_OPENED: 'CRITICAL',
  CIRCUIT_HALF_OPEN: 'INFO',
  CIRCUIT_CLOSED: 'INFO',
  FAILOVER_STARTED: 'WARNING',
  FAILOVER_COMPLETED: 'CRITICAL',
  UPSTREAM_TIMEOUT: 'WARNING',
  HEALTH_CHANGED: 'INFO',
  ANOMALY_DETECTED: 'WARNING',
  ANOMALY_RESOLVED: 'INFO',
};

export const EVENT_TYPES: readonly EventType[] = Object.keys(
  DEFAULT_SEVERITY,
) as readonly EventType[];

export const EVENT_SEVERITIES: readonly EventSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as EventType);
}

export function isEventSeverity(value: unknown): value is EventSeverity {
  return typeof value === 'string' && EVENT_SEVERITIES.includes(value as EventSeverity);
}

export function createResilienceEvent(input: EventInput): ResilienceEvent {
  return {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    eventType: input.eventType,
    service: input.service,
    severity: input.severity ?? DEFAULT_SEVERITY[input.eventType],
    requestId: input.requestId ?? null,
    message: input.message,
    metadata: input.metadata ?? {},
  };
}
