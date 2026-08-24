import { env } from '../config/env';
import { metricValues, type FeatureSnapshot } from './anomalyFeatures';
import { RobustBaseline, robustUpperZ } from './anomalyBaseline';
import {
  DEFAULT_MAX_HISTORY,
  REASON_Z_THRESHOLD,
  SCORED_METRICS,
  SCORING_Z_DENOMINATOR,
  type AnomalyReason,
  type AnomalyStatus,
  type AnomalyStatusReport,
  type AssessmentRecord,
  type MetricBaselineView,
  type MetricKey,
} from './anomalyTypes';

/** Event-stream payload emitted on status TRANSITIONS (never repeatedly). */
export interface AnomalyEmission {
  eventType: 'ANOMALY_DETECTED' | 'ANOMALY_RESOLVED';
  service: string;
  /** New status after the transition. */
  status: AnomalyStatus;
  previousStatus: AnomalyStatus;
  score: number;
  reasons: AnomalyReason[];
}

export type AnomalyEmitter = (emission: AnomalyEmission) => void;

export interface AnomalyDetectorOptions {
  windowSize?: number;
  minSamples?: number;
  scoreWarning?: number;
  scoreAnomalous?: number;
  maxHistory?: number;
  /** Transition hook — production maps this into the resilience event stream. */
  emit?: AnomalyEmitter;
}

interface ServiceRuntime {
  observations: number;
  baselines: Record<MetricKey, RobustBaseline>;
  history: AssessmentRecord[];
  lastStatus: AnomalyStatus;
  lastReport: AnomalyStatusReport | null;
}

const STATUS_SEVERITY: Record<AnomalyStatus, number> = {
  INSUFFICIENT_DATA: 0,
  NORMAL: 1,
  WARNING: 2,
  ANOMALOUS: 3,
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Rolling-baseline anomaly detector (median + MAD robust z-scores).
 *
 * Deterministic by construction: it never reads the wall clock — time comes
 * exclusively from each FeatureSnapshot's timestamp — so tests are exact and
 * behavior is reproducible. One baseline per SERVICE+METRIC (never merged),
 * bounded windows, explicit thresholds, and a reason list explaining every
 * verdict. While a service has fewer than `minSamples` observations the
 * status stays INSUFFICIENT_DATA and NO score is produced (never fabricated).
 */
export class AnomalyDetector {
  private readonly services = new Map<string, ServiceRuntime>();

  readonly windowSize: number;
  readonly minSamples: number;
  readonly scoreWarning: number;
  readonly scoreAnomalous: number;

  constructor(private readonly options: AnomalyDetectorOptions = {}) {
    this.windowSize = options.windowSize ?? env.anomalyWindowSize;
    this.minSamples = options.minSamples ?? env.anomalyMinSamples;
    this.scoreWarning = options.scoreWarning ?? env.anomalyScoreWarning;
    this.scoreAnomalous = options.scoreAnomalous ?? env.anomalyScoreAnomalous;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;

    if (!Number.isInteger(this.windowSize) || this.windowSize < 5) {
      throw new Error(`windowSize must be an integer >= 5, got ${this.windowSize}.`);
    }
    if (
      !Number.isInteger(this.minSamples) ||
      this.minSamples < 2 ||
      this.minSamples > this.windowSize
    ) {
      throw new Error(
        `minSamples must be an integer between 2 and windowSize (${this.windowSize}), got ${this.minSamples}.`,
      );
    }
    if (!(
      this.scoreWarning > 0 &&
      this.scoreWarning < this.scoreAnomalous &&
      this.scoreAnomalous <= 1
    )) {
      throw new Error('Require 0 < scoreWarning < scoreAnomalous <= 1.');
    }
  }

  private readonly maxHistory: number;

  /**
   * Ingest one feature snapshot: update baselines, evaluate, handle status
   * transitions. Pure with respect to time (uses snapshot.timestamp).
   */
  observe(snapshot: FeatureSnapshot): AnomalyStatusReport {
    const runtime = this.runtimeFor(snapshot.service);
    const values = metricValues(snapshot);

    for (const metric of SCORED_METRICS) {
      const value = values[metric];
      if (value !== null) runtime.baselines[metric].push(value);
    }
    runtime.observations += 1;

    if (runtime.observations < this.minSamples) {
      // Cold start: report honestly, produce NO score, raise NO events.
      const report = this.buildReport(snapshot.service, snapshot, 'INSUFFICIENT_DATA', null, []);
      runtime.lastStatus = 'INSUFFICIENT_DATA';
      runtime.lastReport = report;
      return report;
    }

    const { reasons, scores } = this.evaluate(runtime);
    const rawScore = scores.length > 0 ? Math.max(...scores) : 0;
    const score = round2(Math.min(1, Math.max(0, rawScore)));
    const status =
      score >= this.scoreAnomalous
        ? 'ANOMALOUS'
        : score >= this.scoreWarning
          ? 'WARNING'
          : 'NORMAL';

    this.handleTransition(runtime, snapshot.service, status, score, reasons);

    const report = this.buildReport(snapshot.service, snapshot, status, score, reasons);
    runtime.lastStatus = status;
    runtime.lastReport = report;
    return report;
  }

  /** Latest assessment for a service; null when never observed. */
  statusOf(service: string): AnomalyStatusReport | null {
    return this.services.get(service)?.lastReport ?? null;
  }

  /** All tracked services, alphabetical. */
  listReports(): AnomalyStatusReport[] {
    return [...this.services.keys()]
      .sort()
      .map((service) => this.statusOf(service) as AnomalyStatusReport);
  }

  /** Post-cold-start assessment history (bounded), oldest first. */
  history(service: string): AssessmentRecord[] {
    return [...(this.services.get(service)?.history ?? [])];
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private evaluate(runtime: ServiceRuntime): {
    reasons: AnomalyReason[];
    scores: number[];
  } {
    const reasons: AnomalyReason[] = [];
    const scores: number[] = [];

    for (const metric of SCORED_METRICS) {
      const baselineView = runtime.baselines[metric].view();
      // Per-metric sufficiency: a metric with too little history (e.g.
      // latencies absent during idle periods) is skipped, never guessed.
      if (baselineView === null || baselineView.sampleCount < this.minSamples) continue;

      // Rates are always defined; re-read the freshest value pushed.
      const latest = runtime.baselines[metric].lastValue();
      if (latest === null) continue;
      const z = robustUpperZ(latest, metric, baselineView);
      scores.push(Math.min(1, Math.max(0, z / SCORING_Z_DENOMINATOR)));

      if (z >= REASON_Z_THRESHOLD) {
        const changePercent =
          baselineView.median === 0
            ? latest > 0
              ? 100
              : 0
            : Math.round(((latest - baselineView.median) / Math.abs(baselineView.median)) * 100);
        reasons.push({
          metric,
          current: round2(latest),
          baseline: round2(baselineView.median),
          changePercent,
          zScore: round2(z),
        });
      }
    }

    reasons.sort((a, b) => b.zScore - a.zScore);
    return { reasons, scores };
  }

  private handleTransition(
    runtime: ServiceRuntime,
    service: string,
    status: AnomalyStatus,
    score: number,
    reasons: AnomalyReason[],
  ): void {
    const previous = runtime.lastStatus;
    if (previous === status) return;

    const worsened = STATUS_SEVERITY[status] > STATUS_SEVERITY[previous];
    if (worsened && (status === 'WARNING' || status === 'ANOMALOUS')) {
      this.safeEmit({
        eventType: 'ANOMALY_DETECTED',
        service,
        status,
        previousStatus: previous,
        score,
        reasons,
      });
    } else if (status === 'NORMAL' && (previous === 'WARNING' || previous === 'ANOMALOUS')) {
      this.safeEmit({
        eventType: 'ANOMALY_RESOLVED',
        service,
        status,
        previousStatus: previous,
        score,
        reasons,
      });
    }
    // Improvements short of NORMAL (ANOMALOUS -> WARNING) and the silent
    // INSUFFICIENT_DATA -> NORMAL graduation raise no events by design.
  }

  private safeEmit(emission: AnomalyEmission): void {
    if (this.options.emit === undefined) return;
    try {
      this.options.emit(emission);
    } catch {
      // Observers must never be able to break detection itself; the wiring
      // site adds its own containment as well.
    }
  }

  private buildReport(
    service: string,
    snapshot: FeatureSnapshot,
    status: AnomalyStatus,
    score: number | null,
    reasons: AnomalyReason[],
  ): AnomalyStatusReport {
    const runtime = this.services.get(service);
    const baseline: Record<string, MetricBaselineView> = {};
    if (runtime !== undefined) {
      for (const metric of SCORED_METRICS) {
        const view = runtime.baselines[metric].view();
        if (view !== null) baseline[metric] = view;
      }
    }

    if (runtime !== undefined && status !== 'INSUFFICIENT_DATA') {
      const topMetric = reasons.length > 0 ? (reasons[0]?.metric ?? null) : null;
      runtime.history.push({
        timestamp: snapshot.timestamp,
        status,
        score,
        topMetric,
      });
      if (runtime.history.length > this.maxHistory) {
        runtime.history.splice(0, runtime.history.length - this.maxHistory);
      }
    }

    return {
      service,
      timestamp: snapshot.timestamp,
      status,
      score,
      sampleCount: runtime?.observations ?? 0,
      windowSize: this.windowSize,
      featureSnapshot: snapshot,
      baseline,
      reasons,
    };
  }

  private runtimeFor(service: string): ServiceRuntime {
    let runtime = this.services.get(service);
    if (runtime === undefined) {
      const baselines = {} as Record<MetricKey, RobustBaseline>;
      for (const metric of SCORED_METRICS) {
        baselines[metric] = new RobustBaseline(this.windowSize);
      }
      runtime = {
        observations: 0,
        baselines,
        history: [],
        lastStatus: 'INSUFFICIENT_DATA',
        lastReport: null,
      };
      this.services.set(service, runtime);
    }
    return runtime;
  }
}

/** Composition-root factory — reads validated env configuration. */
export function createAnomalyDetectorFromEnv(
  options: AnomalyDetectorOptions = {},
): AnomalyDetector {
  return new AnomalyDetector(options);
}
