import { logger } from '../utils/logger';
import type { MetricsSnapshot } from '../observability/metricsCollector.service';
import {
  buildFeatureSnapshot,
  counterPositionFor,
  type CounterPosition,
  type FeatureSnapshot,
} from './anomalyFeatures';

export interface MetricSamplerDeps {
  /** Live view of the observability layer's metrics (the ONLY data source). */
  getMetrics(): MetricsSnapshot;
  /** Consumer of built snapshots (production: anomalyDetector.observe). */
  onSample(snapshot: FeatureSnapshot): void;
  /** Sampling cadence in ms. */
  intervalMs: number;
}

/**
 * Periodic feature-snapshot builder.
 *
 * Design points:
 *  - ONE timer for ALL services (never one per service), unref()'d so it can
 *    never keep the process alive, and stoppable for tests/shutdown.
 *  - Deltas are computed against the previous tick's counter positions; the
 *    first tick per service only SEEDS the reference (no emission), which
 *    avoids a boot-time spike of lifetime totals.
 *  - Idle intervals (requestVolume === 0) produce NO sample so baselines
 *    stay traffic-shaped instead of being diluted with zeros.
 *  - tick() is public and synchronous so tests drive it manually with fake
 *    metric sources — fully deterministic, no sleeping.
 *  - Every failure is contained: sampling problems log and continue, they
 *    can never crash the process or affect request handling.
 */
export class MetricSampler {
  private timer: NodeJS.Timeout | null = null;
  private readonly positions = new Map<string, CounterPosition>();

  constructor(private readonly deps: MetricSamplerDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.tick(); // seed reference positions immediately
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs);
    this.timer.unref();
    logger.info('anomaly_sampler_started', { intervalMs: this.deps.intervalMs });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('anomaly_sampler_stopped');
  }

  /** One sampling pass over every tracked service. Safe to call manually. */
  tick(): void {
    try {
      const snapshot = this.deps.getMetrics();
      const timestamp = new Date().toISOString();

      for (const [service, metrics] of Object.entries(snapshot.services)) {
        const position = counterPositionFor(snapshot, service);
        if (position === null) continue;

        const previous = this.positions.get(service);
        this.positions.set(service, position);
        if (previous === undefined) continue; // seeding tick

        const feature = buildFeatureSnapshot(service, timestamp, position, previous, {
          avgLatencyMs: metrics.averageLatencyMs,
          p95LatencyMs: metrics.p95LatencyMs,
        });
        if (feature === null) continue; // idle interval

        try {
          this.deps.onSample(feature);
        } catch (error) {
          logger.error('anomaly_sample_consumer_error', {
            service,
            errorMessage: (error as Error).message,
          });
        }
      }
    } catch (error) {
      logger.error('anomaly_sampler_tick_error', { errorMessage: (error as Error).message });
    }
  }
}
