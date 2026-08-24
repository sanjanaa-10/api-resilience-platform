import type { MetricsSnapshot } from '../observability/metricsCollector.service';
import type { MetricKey } from './anomalyTypes';

/**
 * One normalized observation of a service's behavior over ONE sampling
 * interval, derived exclusively from the existing metrics collector
 * (deltas of cumulative counters + current latency statistics).
 *
 * Rates are clamped to [0, 1] so no counter quirk (e.g. several timeout
 * attempts inside one logical request) can produce out-of-range features.
 */
export interface FeatureSnapshot {
  service: string;
  timestamp: string;
  /** Requests observed for this service during the interval. */
  requestVolume: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  errorRate: number;
  timeoutRate: number;
  retryRate: number;
  failoverRate: number;
}

/** Cumulative counters needed to compute per-interval deltas. */
export interface CounterPosition {
  requestCount: number;
  failureCount: number;
  timeoutCount: number;
  retryCount: number;
  failoverCount: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Extract the counter position for one service from a metrics snapshot. */
export function counterPositionFor(
  snapshot: MetricsSnapshot,
  service: string,
): CounterPosition | null {
  const state = snapshot.services[service];
  if (state === undefined) return null;
  return {
    requestCount: state.requestCount,
    failureCount: state.failureCount,
    timeoutCount: state.timeoutCount,
    retryCount: state.retryCount,
    failoverCount: state.failoverCount,
  };
}

/**
 * Pure delta computation between two counter positions. Returns null when
 * nothing was observed in the interval (requestVolume === 0) — idle periods
 * produce NO sample so baselines stay traffic-shaped instead of being
 * diluted with zeros.
 */
export function buildFeatureSnapshot(
  service: string,
  timestamp: string,
  current: CounterPosition,
  previous: CounterPosition,
  latencies: { avgLatencyMs: number | null; p95LatencyMs: number | null },
): FeatureSnapshot | null {
  const volume = current.requestCount - previous.requestCount;
  if (volume <= 0) return null;

  const safeVolume = Math.max(1, volume);
  return {
    service,
    timestamp,
    requestVolume: volume,
    avgLatencyMs: latencies.avgLatencyMs,
    p95LatencyMs: latencies.p95LatencyMs,
    errorRate: clamp01((current.failureCount - previous.failureCount) / safeVolume),
    timeoutRate: clamp01((current.timeoutCount - previous.timeoutCount) / safeVolume),
    retryRate: clamp01((current.retryCount - previous.retryCount) / safeVolume),
    failoverRate: clamp01((current.failoverCount - previous.failoverCount) / safeVolume),
  };
}

/** Metric values extracted for scoring; null metrics are skipped by the detector. */
export function metricValues(snapshot: FeatureSnapshot): Record<MetricKey, number | null> {
  return {
    avgLatencyMs: snapshot.avgLatencyMs,
    p95LatencyMs: snapshot.p95LatencyMs,
    errorRate: snapshot.errorRate,
    timeoutRate: snapshot.timeoutRate,
    retryRate: snapshot.retryRate,
    failoverRate: snapshot.failoverRate,
  };
}
