import { randomUUID } from 'node:crypto';
import type { EventSeverity, EventType, ResilienceEvent } from './events';

export type IncidentStatus = 'ACTIVE' | 'RESOLVED';
/** Incident severity mirrors event severity but only ever escalates. */
export type IncidentSeverity = EventSeverity;

/** One chronological entry inside an incident timeline. */
export interface IncidentTimelineEntry {
  timestamp: string;
  eventType: EventType;
  severity: EventSeverity;
  requestId: string | null;
  message: string;
}

/** Public incident view (timeline included). */
export interface Incident {
  incidentId: string;
  service: string;
  startedAt: string;
  endedAt: string | null;
  status: IncidentStatus;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  eventCount: number;
  failoverOccurred: boolean;
  circuitOpened: boolean;
  /** Distinct requests that experienced a failure signal. */
  affectedRequests: number;
  timeline: IncidentTimelineEntry[];
}

export interface IncidentAggregatorOptions {
  /** Warning signals within the lookback window that open an incident. */
  failureThreshold: number;
  /** Rolling window for counting warning signals (ms). */
  lookbackMs: number;
  /** Failure-free period required before quiet-period resolution (ms). */
  recoveryQuietMs: number;
  /** Resolved incidents retained in memory (oldest evicted). */
  maxResolvedIncidents: number;
  /** Injectable clock for deterministic tests (defaults to wall clock). */
  now?: () => number;
}

/**
 * Events that indicate something is wrong RIGHT NOW. Any of them counts
 * toward the threshold and attaches to an open incident.
 */
const FAILURE_SIGNALS: ReadonlySet<EventType> = new Set<EventType>([
  'UPSTREAM_TIMEOUT',
  'REQUEST_FAILED',
  'FAILOVER_STARTED',
  'FAILOVER_COMPLETED',
  'CIRCUIT_OPENED',
]);

/**
 * Non-failure events worth recording on an ACTIVE incident's timeline
 * (context for the investigator). They never start or extend incidents.
 * ANOMALY_DETECTED is supporting evidence: the detector explains WHY it
 * flagged a service, incidents stay governed by their own rules.
 */
const CONTEXT_SIGNALS: ReadonlySet<EventType> = new Set<EventType>([
  'RETRY_ATTEMPT',
  'CIRCUIT_HALF_OPEN',
  'ANOMALY_DETECTED',
]);

const TIMELINE_CAP = 1000;

interface IncidentRuntime extends Incident {
  affectedRequestIds: Set<string>;
  failureSignalCount: number;
  timeoutCount: number;
  retryCount: number;
  lastFailureAtMs: number | null;
}

interface ServiceTracking {
  runtime: IncidentRuntime | null;
  recentFailureAtMs: number[];
  /**
   * Failure/context events observed BEFORE any incident opened. A newly
   * created incident replays them into its timeline so the investigation
   * view contains the buildup, not just the aftermath. Bounded by count
   * and by the lookback window.
   */
  pendingEvents: ResilienceEvent[];
}

/** Max pre-incident events buffered per service for timeline backfill. */
const PENDING_EVENT_CAP = 50;

function compareByStartedDesc(a: IncidentRuntime, b: IncidentRuntime): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

function toPublicIncident(runtime: IncidentRuntime): Incident {
  return {
    incidentId: runtime.incidentId,
    service: runtime.service,
    startedAt: runtime.startedAt,
    endedAt: runtime.endedAt,
    status: runtime.status,
    severity: runtime.severity,
    title: runtime.title,
    summary: runtime.summary,
    eventCount: runtime.eventCount,
    failoverOccurred: runtime.failoverOccurred,
    circuitOpened: runtime.circuitOpened,
    affectedRequests: runtime.affectedRequests,
    timeline: [...runtime.timeline],
  };
}

/**
 * Deterministic incident engine.
 *
 * Rules (no heuristics):
 *   START    - CIRCUIT_OPENED immediately, OR `failureThreshold` failure
 *              signals inside the rolling `lookbackMs` window.
 *   ATTACH   - every subsequent failure/context event for the same service
 *              joins the ACTIVE incident instead of spawning duplicates.
 *   ESCALATE - circuit opening or failover raises severity to CRITICAL
 *              and sets the corresponding flag on the incident.
 *   RESOLVE  - CIRCUIT_CLOSED resolves instantly; otherwise the incident
 *              resolves lazily once no failure signal occurred for
 *              `recoveryQuietMs`.
 *
 * All time math flows through the injectable clock so tests are exact and
 * no timers are created per incident (same lazy pattern as refill/circuit).
 */
export class IncidentAggregator {
  private readonly services = new Map<string, ServiceTracking>();
  private readonly resolved: IncidentRuntime[] = [];

  constructor(private readonly options: IncidentAggregatorOptions) {}

  observe(event: ResilienceEvent): void {
    const tracking = this.trackingFor(event.service);
    const now = this.clock()();

    // Explicit recovery signal wins over the passive quiet-period check:
    // if the breaker just closed, that — not silence — ends the incident.
    if (event.eventType === 'CIRCUIT_CLOSED') {
      if (tracking.runtime !== null) {
        this.resolve(tracking, tracking.runtime, now, 'circuit closed');
      }
      return;
    }

    // Lazy recovery check runs on ANY observation for this service.
    this.maybeResolve(tracking, now);

    const isFailure = FAILURE_SIGNALS.has(event.eventType);
    const isContext =
      CONTEXT_SIGNALS.has(event.eventType) ||
      (event.eventType === 'HEALTH_CHANGED' && event.severity !== 'INFO');
    if (!isFailure && !isContext) return;

    if (tracking.runtime !== null) {
      this.attach(tracking.runtime, event, now);

      if (event.eventType === 'CIRCUIT_OPENED') {
        tracking.runtime.circuitOpened = true;
        tracking.runtime.severity = 'CRITICAL';
      }
      if (event.eventType === 'FAILOVER_STARTED' || event.eventType === 'FAILOVER_COMPLETED') {
        tracking.runtime.failoverOccurred = true;
        tracking.runtime.severity = 'CRITICAL';
      }
      tracking.runtime.summary = this.summarize(tracking.runtime);
      return;
    }

    // No active incident: count the signal and decide whether to open one.
    if (isFailure) {
      tracking.recentFailureAtMs.push(now);
      const cutoff = now - this.options.lookbackMs;
      tracking.recentFailureAtMs = tracking.recentFailureAtMs.filter((at) => at >= cutoff);

      const shouldStart =
        event.eventType === 'CIRCUIT_OPENED' ||
        tracking.recentFailureAtMs.length >= this.options.failureThreshold;
      if (shouldStart) {
        tracking.runtime = this.createIncident(tracking, event, now);
        return;
      }
    }

    // Below threshold — retain for backfill in case an incident opens later.
    this.bufferPending(tracking, event, now);
  }

  /** All incidents, newest first; active incidents precede resolved ones. */
  list(): Incident[] {
    return [
      ...this.activeRuntimes().sort(compareByStartedDesc),
      ...[...this.resolved].sort(compareByStartedDesc),
    ].map(toPublicIncident);
  }

  active(): Incident[] {
    return this.activeRuntimes().sort(compareByStartedDesc).map(toPublicIncident);
  }

  get(id: string): Incident | null {
    for (const runtime of this.activeRuntimes()) {
      if (runtime.incidentId === id) return toPublicIncident(runtime);
    }
    const resolved = this.resolved.find((runtime) => runtime.incidentId === id);
    return resolved !== undefined ? toPublicIncident(resolved) : null;
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** Retain a pre-incident event for later timeline backfill. */
  private bufferPending(tracking: ServiceTracking, event: ResilienceEvent, now: number): void {
    tracking.pendingEvents.push(event);
    if (tracking.pendingEvents.length > PENDING_EVENT_CAP) {
      tracking.pendingEvents.splice(0, tracking.pendingEvents.length - PENDING_EVENT_CAP);
    }
    // Drop events that fell out of the lookback window — they can no longer
    // contribute to a future incident's threshold or relevance.
    const cutoff = now - this.options.lookbackMs;
    tracking.pendingEvents = tracking.pendingEvents.filter(
      (pending) => Date.parse(pending.timestamp) >= cutoff,
    );
  }

  /**
   * Creates the incident and replays every buffered buildup event into its
   * timeline so counters (timeouts, retries, affected requests) reflect the
   * full story from the FIRST signal, not just the triggering one.
   */
  private createIncident(
    tracking: ServiceTracking,
    trigger: ResilienceEvent,
    now: number,
  ): IncidentRuntime {
    const byCircuit = trigger.eventType === 'CIRCUIT_OPENED';
    // A failover signal is itself proof traffic was disrupted -> CRITICAL.
    const byFailover =
      trigger.eventType === 'FAILOVER_STARTED' || trigger.eventType === 'FAILOVER_COMPLETED';
    const firstTimestamp = tracking.pendingEvents[0]?.timestamp ?? trigger.timestamp;
    const runtime: IncidentRuntime = {
      incidentId: randomUUID(),
      service: trigger.service,
      startedAt: firstTimestamp,
      endedAt: null,
      status: 'ACTIVE',
      severity: byCircuit || byFailover ? 'CRITICAL' : 'WARNING',
      title: byCircuit
        ? `Circuit opened for ${trigger.service}`
        : byFailover
          ? `Traffic failed over from ${trigger.service}`
          : `Failures detected on ${trigger.service}`,
      summary: '',
      eventCount: 0,
      failoverOccurred: byFailover,
      circuitOpened: byCircuit,
      affectedRequests: 0,
      timeline: [],
      affectedRequestIds: new Set<string>(),
      failureSignalCount: 0,
      timeoutCount: 0,
      retryCount: 0,
      lastFailureAtMs: now,
    };
    for (const pending of tracking.pendingEvents) this.attach(runtime, pending, now);
    this.attach(runtime, trigger, now);
    tracking.pendingEvents = [];
    runtime.summary = this.summarize(runtime);
    return runtime;
  }

  private attach(runtime: IncidentRuntime, event: ResilienceEvent, now: number): void {
    runtime.timeline.push({
      timestamp: event.timestamp,
      eventType: event.eventType,
      severity: event.severity,
      requestId: event.requestId,
      message: event.message,
    });
    if (runtime.timeline.length > TIMELINE_CAP) {
      runtime.timeline.splice(0, runtime.timeline.length - TIMELINE_CAP);
    }
    runtime.eventCount += 1;

    if (FAILURE_SIGNALS.has(event.eventType)) {
      runtime.failureSignalCount += 1;
      if (event.requestId !== null) runtime.affectedRequestIds.add(event.requestId);
      runtime.lastFailureAtMs = Math.max(runtime.lastFailureAtMs ?? Number.NEGATIVE_INFINITY, now);
    }
    if (event.eventType === 'UPSTREAM_TIMEOUT') runtime.timeoutCount += 1;
    if (event.eventType === 'RETRY_ATTEMPT') runtime.retryCount += 1;

    runtime.affectedRequests = runtime.affectedRequestIds.size;
  }

  /**
   * Quiet-period resolution, evaluated lazily whenever the service produces
   * its next observation: no timers needed, deterministic from the clock.
   */
  private maybeResolve(tracking: ServiceTracking, now: number): void {
    const runtime = tracking.runtime;
    if (runtime === null) return;
    const lastFailureAtMs = runtime.lastFailureAtMs ?? Date.parse(runtime.startedAt);
    if (now - lastFailureAtMs < this.options.recoveryQuietMs) return;
    this.resolve(tracking, runtime, now, 'quiet period elapsed without failures');
  }

  private resolve(
    tracking: ServiceTracking,
    runtime: IncidentRuntime,
    now: number,
    reason: string,
  ): void {
    runtime.status = 'RESOLVED';
    runtime.endedAt = new Date(now).toISOString();
    runtime.summary = `${this.summarize(runtime)} Resolved (${reason}).`;
    tracking.runtime = null;
    tracking.recentFailureAtMs = [];
    this.resolved.unshift(runtime);
    if (this.resolved.length > this.options.maxResolvedIncidents) {
      this.resolved.splice(this.options.maxResolvedIncidents);
    }
  }

  private summarize(runtime: IncidentRuntime): string {
    const parts: string[] = [`${runtime.failureSignalCount} failure signals`];
    if (runtime.timeoutCount > 0) parts.push(`${runtime.timeoutCount} upstream timeouts`);
    if (runtime.retryCount > 0) parts.push(`${runtime.retryCount} retries`);
    if (runtime.circuitOpened) parts.push('circuit OPENED');
    if (runtime.failoverOccurred) parts.push('traffic failed over');
    return `${parts.join(', ')}.`;
  }

  private trackingFor(service: string): ServiceTracking {
    let tracking = this.services.get(service);
    if (tracking === undefined) {
      tracking = { runtime: null, recentFailureAtMs: [], pendingEvents: [] };
      this.services.set(service, tracking);
    }
    return tracking;
  }

  private activeRuntimes(): IncidentRuntime[] {
    const runtimes: IncidentRuntime[] = [];
    for (const tracking of this.services.values()) {
      if (tracking.runtime !== null) runtimes.push(tracking.runtime);
    }
    return runtimes;
  }

  private clock(): () => number {
    return this.options.now ?? Date.now;
  }
}
