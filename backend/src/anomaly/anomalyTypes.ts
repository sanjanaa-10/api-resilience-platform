/**
 * Explainable statistical anomaly detection — shared vocabulary.
 *
 * This is a robust-statistics detector (rolling median + MAD), NOT a trained
 * supervised model. Everything it reports is derived from real metrics
 * collected by the observability layer and can be traced back to numbers.
 */
import type { FeatureSnapshot } from './anomalyFeatures';

export type AnomalyStatus = 'NORMAL' | 'WARNING' | 'ANOMALOUS' | 'INSUFFICIENT_DATA';

export const ANOMALY_STATUSES: readonly AnomalyStatus[] = [
  'NORMAL',
  'WARNING',
  'ANOMALOUS',
  'INSUFFICIENT_DATA',
];

/**
 * Metrics fed to the detector. All are one-sided (only INCREASES vs the
 * baseline indicate degradation): slower latency, more errors, timeouts,
 * retries or failovers. requestVolume is captured in the feature snapshot
 * but deliberately NOT scored — traffic growth is a business event, not a
 * health degradation.
 */
export type MetricKey =
  'avgLatencyMs' | 'p95LatencyMs' | 'errorRate' | 'timeoutRate' | 'retryRate' | 'failoverRate';

export const SCORED_METRICS: readonly MetricKey[] = [
  'avgLatencyMs',
  'p95LatencyMs',
  'errorRate',
  'timeoutRate',
  'retryRate',
  'failoverRate',
];

/**
 * Scoring constants (documented defaults, not universal truths):
 *
 *  - SCORING_Z_DENOMINATOR: robust z-score at which ONE metric alone drives
 *    the overall score to 1.0. score = clamp(z / 8). With the default
 *    thresholds this means WARNING begins at z >= 4 and ANOMALOUS at
 *    z >= 6.4 for the worst metric.
 *  - REASON_Z_THRESHOLD: minimum per-metric z for that metric to appear in
 *    the explanation's reasons list.
 */
export const SCORING_Z_DENOMINATOR = 8;
export const REASON_Z_THRESHOLD = 3;

/**
 * Dispersion fallbacks when the history is constant (MAD === 0). The
 * denominator then becomes max(5% of the median, this floor) so a change
 * from a perfectly flat baseline still produces a finite, explainable z.
 */
export const RATE_METRIC_FLOOR = 0.02; // 2 percentage points for rate metrics
export const LATENCY_METRIC_FLOOR_MS = 25; // ms granularity for latency metrics

/** Default detector configuration (mirrored by env parsing). */
export const DEFAULT_WINDOW_SIZE = 30;
export const DEFAULT_MIN_SAMPLES = 10;
/** Resolved assessments kept per service for /history. */
export const DEFAULT_MAX_HISTORY = 50;

export interface MetricBaselineView {
  /** Rolling median of the retained window. */
  median: number;
  /** Median absolute deviation of the retained window. */
  mad: number;
  /** How many samples the baseline for THIS metric currently holds. */
  sampleCount: number;
}

/** One explained contributor to an anomaly verdict. */
export interface AnomalyReason {
  metric: MetricKey;
  current: number;
  baseline: number;
  /** Rounded percent change vs baseline (100 = doubled). */
  changePercent: number;
  /** One-sided robust z-score (|x − median| / (1.4826·MAD)). */
  zScore: number;
}

export interface AssessmentRecord {
  timestamp: string;
  status: AnomalyStatus;
  /** null only while INSUFFICIENT_DATA (no fake scores). */
  score: number | null;
  /** Worst-contributing metric at assessment time; null when none. */
  topMetric: MetricKey | null;
}

export interface AnomalyStatusReport {
  service: string;
  timestamp: string;
  status: AnomalyStatus;
  /** 0..1, null while INSUFFICIENT_DATA. */
  score: number | null;
  sampleCount: number;
  windowSize: number;
  featureSnapshot: FeatureSnapshot;
  baseline: Record<string, MetricBaselineView>;
  reasons: AnomalyReason[];
}
