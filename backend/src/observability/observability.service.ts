import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { EventInput, ResilienceEvent } from './events';
import { createResilienceEvent } from './events';
import { ResilienceEventStore, type EventQuery } from './eventStore.service';
import { MetricsCollector, type MetricsSnapshot } from './metricsCollector.service';
import {
  IncidentAggregator,
  type Incident,
  type IncidentAggregatorOptions,
} from './incidentAggregator.service';

export interface ObservabilityServiceOptions {
  eventCapacity?: number;
  latencyWindow?: number;
  incident?: Pick<
    IncidentAggregatorOptions,
    'failureThreshold' | 'lookbackMs' | 'recoveryQuietMs' | 'maxResolvedIncidents'
  > & { now?: () => number };
}

/**
 * Single entry point for resilience observability.
 *
 * Contract: record() NEVER throws and NEVER lets a broken sink break a
 * request. Each consumer (store / metrics / incidents) is isolated in its
 * own try/catch so one failing sink degrades only itself — the other two
 * keep working. This is what allows every hot path in the gateway to call
 * observability unconditionally.
 */
export class ObservabilityService {
  readonly store: ResilienceEventStore;
  readonly metrics: MetricsCollector;
  readonly incidents: IncidentAggregator;

  constructor(options: ObservabilityServiceOptions = {}) {
    this.store = new ResilienceEventStore(options.eventCapacity ?? env.eventsCapacity);
    this.metrics = new MetricsCollector(options.latencyWindow ?? env.metricsLatencyWindow);
    this.incidents = new IncidentAggregator({
      failureThreshold: options.incident?.failureThreshold ?? env.incidentFailureThreshold,
      lookbackMs: options.incident?.lookbackMs ?? env.incidentLookbackMs,
      recoveryQuietMs: options.incident?.recoveryQuietMs ?? env.incidentRecoveryQuietMs,
      maxResolvedIncidents: options.incident?.maxResolvedIncidents ?? env.incidentMaxResolved,
      ...(options.incident?.now !== undefined ? { now: options.incident.now } : {}),
    });
  }

  /** Creates the event, fans it out to all sinks; returns null on failure. */
  record(input: EventInput): ResilienceEvent | null {
    try {
      const event = createResilienceEvent(input);

      try {
        this.store.append(event);
      } catch (error) {
        logger.error('observability_store_error', { errorMessage: (error as Error).message });
      }
      try {
        this.metrics.observe(event);
      } catch (error) {
        logger.error('observability_metrics_error', { errorMessage: (error as Error).message });
      }
      try {
        this.incidents.observe(event);
      } catch (error) {
        logger.error('observability_incidents_error', { errorMessage: (error as Error).message });
      }

      return event;
    } catch (error) {
      // Even event construction is guarded — observability must be unable
      // to take the request path down with it.
      logger.error('observability_record_error', { errorMessage: (error as Error).message });
      return null;
    }
  }

  listEvents(query: EventQuery = {}): ResilienceEvent[] {
    return this.store.list(query);
  }

  getMetrics(): MetricsSnapshot {
    return this.metrics.getSnapshot();
  }

  listIncidents(): Incident[] {
    return this.incidents.list();
  }

  listActiveIncidents(): Incident[] {
    return this.incidents.active();
  }

  getIncident(id: string): Incident | null {
    return this.incidents.get(id);
  }
}

/** Composition-root factory — reads validated env configuration. */
export function createObservabilityServiceFromEnv(): ObservabilityService {
  return new ObservabilityService();
}
