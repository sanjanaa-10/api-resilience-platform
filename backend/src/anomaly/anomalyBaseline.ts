import {
  LATENCY_METRIC_FLOOR_MS,
  RATE_METRIC_FLOOR,
  type MetricBaselineView,
  type MetricKey,
} from './anomalyTypes';

/**
 * Robust (median/MAD) rolling baseline for ONE service+metric.
 *
 * Why median + MAD instead of mean/stddev?
 *   - A single huge spike drags the MEAN far off center and inflates the
 *     STDDEV, which both masks the spike itself and poisons later
 *     detection. The MEDIAN ignores up to half outliers, and the MAD is
 *     equally insensitive, so baselines stay stable under exactly the
 *     conditions we are trying to detect.
 *   - 1.4826 · MAD approximates the standard deviation of clean,
 *     roughly-normal data, so the familiar "how many sigmas?" intuition
 *     survives — while remaining robust when data is NOT normal.
 */
export class RobustBaseline {
  private values: number[] = [];

  constructor(private readonly windowSize: number) {}

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.windowSize) {
      this.values.splice(0, this.values.length - this.windowSize);
    }
  }

  get sampleCount(): number {
    return this.values.length;
  }

  /** Most recently pushed value (the "current" observation when scoring). */
  lastValue(): number | null {
    return this.values.length > 0 ? (this.values[this.values.length - 1] ?? null) : null;
  }

  /** Deterministic median; even counts average the two middle values. */
  median(): number | null {
    const n = this.values.length;
    if (n === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const lower = sorted[mid - 1];
    const upper = sorted[mid];
    return n % 2 === 1 ? (upper as number) : ((lower as number) + (upper as number)) / 2;
  }

  /** Median absolute deviation around the median. */
  mad(): number | null {
    const median = this.median();
    if (median === null) return null;
    const deviations = this.values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
    const n = deviations.length;
    const mid = Math.floor(n / 2);
    const lower = deviations[mid - 1];
    const upper = deviations[mid];
    return n % 2 === 1 ? (upper as number) : ((lower as number) + (upper as number)) / 2;
  }

  view(): MetricBaselineView | null {
    const median = this.median();
    const mad = this.mad();
    if (median === null || mad === null) return null;
    return { median, mad, sampleCount: this.values.length };
  }
}

/**
 * Dispersion floor per metric family for the constant-history case
 * (MAD === 0): rates get a percentage-point floor, latencies an ms floor.
 */
export function dispersionFloor(metric: MetricKey): number {
  return metric === 'avgLatencyMs' || metric === 'p95LatencyMs'
    ? LATENCY_METRIC_FLOOR_MS
    : RATE_METRIC_FLOOR;
}

/**
 * ONE-SIDED robust z-score: how many robust sigmas ABOVE the baseline the
 * observation sits. Values at or below the median are perfectly healthy by
 * definition (z = 0) — low latency and zero errors are never anomalies.
 *
 * Constant-history handling: when MAD === 0 any change IS meaningful; the
 * denominator becomes max(5% of the median, metric floor), keeping z finite.
 */
export function robustUpperZ(
  value: number,
  metric: MetricKey,
  baseline: MetricBaselineView,
): number {
  if (value <= baseline.median) return 0;
  const denom =
    baseline.mad > 0
      ? 1.4826 * baseline.mad
      : Math.max(Math.abs(baseline.median) * 0.05, dispersionFloor(metric));
  return (value - baseline.median) / denom;
}
