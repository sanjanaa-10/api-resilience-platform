import type { ResilienceEvent } from './events';

/** Counters + latency statistics tracked for ONE service key. */
export interface ServiceMetrics {
  /** Logical gateway requests started for this service (or globally). */
  requestCount: number;
  successCount: number;
  failureCount: number;
  /** Mean of retained latency samples; null before the first terminal event. */
  averageLatencyMs: number | null;
  /** 95th percentile over retained samples; null before any sample. */
  p95LatencyMs: number | null;
  timeoutCount: number;
  retryCount: number;
  failoverCount: number;
}

export interface MetricsSnapshot {
  generatedAt: string;
  /** Platform-wide counters (circuitOpenCount only exists at this level). */
  totals: ServiceMetrics & { circuitOpenCount: number };
  services: Record<string, ServiceMetrics>;
}

interface MetricsState extends ServiceMetrics {
  latencies: number[];
}

function createState(): MetricsState {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    averageLatencyMs: null,
    p95LatencyMs: null,
    timeoutCount: 0,
    retryCount: 0,
    failoverCount: 0,
    latencies: [],
  };
}

/**
 * Deterministic percentile: sort a copy ascending, take index
 * ceil(0.95 * n) - 1 — no interpolation, same input always yields the
 * same answer, trivially explainable in an interview.
 */
export function percentile95(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  const value = sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  return value ?? null;
}

/**
 * Aggregates resilience events into counters and latency statistics.
 *
 * Latency accounting: every terminal REQUEST_COMPLETED / REQUEST_FAILED
 * contributes its metadata.durationMs to a bounded per-service window
 * (oldest evicted) so statistics reflect recent behavior.
 */
export class MetricsCollector {
  private readonly services = new Map<string, MetricsState>();
  private readonly totals: MetricsState & { circuitOpenCount: number };

  constructor(private readonly latencyWindow: number) {
    if (!Number.isInteger(latencyWindow) || latencyWindow < 1) {
      throw new Error(`Latency window must be a positive integer, got ${latencyWindow}.`);
    }
    this.totals = { ...createState(), circuitOpenCount: 0 };
  }

  observe(event: ResilienceEvent): void {
    const state = this.stateFor(event.service);

    switch (event.eventType) {
      case 'REQUEST_STARTED':
        state.requestCount += 1;
        this.totals.requestCount += 1;
        break;
      case 'REQUEST_COMPLETED':
        state.successCount += 1;
        this.totals.successCount += 1;
        this.recordLatency(state, event);
        this.recordTotalsLatency(event);
        this.refreshLatencies(this.totals);
        break;
      case 'REQUEST_FAILED':
        state.failureCount += 1;
        this.totals.failureCount += 1;
        this.recordLatency(state, event);
        this.recordTotalsLatency(event);
        this.refreshLatencies(this.totals);
        break;
      case 'UPSTREAM_TIMEOUT':
        state.timeoutCount += 1;
        this.totals.timeoutCount += 1;
        break;
      case 'RETRY_ATTEMPT':
        state.retryCount += 1;
        this.totals.retryCount += 1;
        break;
      case 'FAILOVER_COMPLETED':
        state.failoverCount += 1;
        this.totals.failoverCount += 1;
        break;
      case 'CIRCUIT_OPENED':
        this.totals.circuitOpenCount += 1;
        break;
      default:
        break; // informational events carry no counters
    }

    this.refreshLatencies(state);
  }

  getSnapshot(): MetricsSnapshot {
    const services: Record<string, ServiceMetrics> = {};
    for (const name of [...this.services.keys()].sort()) {
      const state = this.services.get(name);
      if (state !== undefined) services[name] = this.toPublic(state);
    }
    return {
      generatedAt: new Date().toISOString(),
      totals: { ...this.toPublic(this.totals), circuitOpenCount: this.totals.circuitOpenCount },
      services,
    };
  }

  private stateFor(service: string): MetricsState {
    let state = this.services.get(service);
    if (state === undefined) {
      state = createState();
      this.services.set(service, state);
    }
    return state;
  }

  private recordLatency(state: MetricsState, event: ResilienceEvent): void {
    const duration = event.metadata['durationMs'];
    if (typeof duration !== 'number' || !Number.isFinite(duration)) return;
    state.latencies.push(duration);
    if (state.latencies.length > this.latencyWindow) {
      state.latencies.splice(0, state.latencies.length - this.latencyWindow);
    }
  }

  private refreshLatencies(state: MetricsState): void {
    if (state.latencies.length === 0) return;
    const sum = state.latencies.reduce((acc, value) => acc + value, 0);
    state.averageLatencyMs = Math.round((sum / state.latencies.length) * 100) / 100;
    state.p95LatencyMs = percentile95(state.latencies);
  }

  private recordTotalsLatency(event: ResilienceEvent): void {
    const duration = event.metadata['durationMs'];
    if (typeof duration !== 'number' || !Number.isFinite(duration)) return;
    this.totals.latencies.push(duration);
    if (this.totals.latencies.length > this.latencyWindow) {
      this.totals.latencies.splice(0, this.totals.latencies.length - this.latencyWindow);
    }
  }

  private toPublic(state: MetricsState): ServiceMetrics {
    return {
      requestCount: state.requestCount,
      successCount: state.successCount,
      failureCount: state.failureCount,
      averageLatencyMs: state.averageLatencyMs,
      p95LatencyMs: state.p95LatencyMs,
      timeoutCount: state.timeoutCount,
      retryCount: state.retryCount,
      failoverCount: state.failoverCount,
    };
  }
}
