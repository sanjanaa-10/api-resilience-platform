import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MetricsSnapshot } from '../src/observability/metricsCollector.service';
import { AnomalyDetector } from '../src/anomaly/anomalyDetector.service';
import { MetricSampler } from '../src/anomaly/metricSampler.service';
import { buildFeatureSnapshot, counterPositionFor } from '../src/anomaly/anomalyFeatures';
import type { FeatureSnapshot } from '../src/anomaly/anomalyFeatures';
import { RobustBaseline, robustUpperZ } from '../src/anomaly/anomalyBaseline';
import { SCORED_METRICS, type MetricKey } from '../src/anomaly/anomalyTypes';
import type { CounterPosition } from '../src/anomaly/anomalyFeatures';

/**
 * Step 9 unit tests — the detector is deterministic by construction (it
 * never reads the wall clock; time comes only from snapshot timestamps),
 * so every scenario below is exact with no sleeps or fake timers.
 */

const T0 = Date.parse('2026-08-24T10:00:00.000Z');
const at = (index: number): string => new Date(T0 + index * 5_000).toISOString();

function makeMetrics(
  service: string,
  counters: {
    requests?: number;
    successes?: number;
    failures?: number;
    timeouts?: number;
    retries?: number;
    failovers?: number;
    avgLatencyMs?: number;
    p95LatencyMs?: number;
    rateLimitedTotal?: number;
  },
): MetricsSnapshot {
  const totals = {
    requestCount: counters.requests ?? 0,
    successCount: counters.successes ?? 0,
    failureCount: counters.failures ?? 0,
    timeoutCount: counters.timeouts ?? 0,
    retryCount: counters.retries ?? 0,
    circuitOpenCount: 0,
    failoverCount: counters.failovers ?? 0,
    rateLimitedTotal: counters.rateLimitedTotal ?? 0,
    generatedAt: new Date().toISOString(),
  };
  return {
    generatedAt: new Date().toISOString(),
    totals,
    services: {
      [service]: {
        service,
        requestCount: counters.requests ?? 0,
        successCount: counters.successes ?? 0,
        failureCount: counters.failures ?? 0,
        timeoutCount: counters.timeouts ?? 0,
        retryCount: counters.retries ?? 0,
        failoverCount: counters.failovers ?? 0,
        averageLatencyMs: counters.avgLatencyMs ?? 0,
        p95LatencyMs: counters.p95LatencyMs ?? 0,
      },
    },
    windowSeconds: 60,
  };
}

/** Feed `count` stable observations (~100ms, ~1% errors) then return the detector. */
function warmedDetector(count: number, options = {}): AnomalyDetector {
  const detector = new AnomalyDetector(options);
  for (let i = 0; i < count; i += 1) {
    detector.observe({
      service: 'payment',
      timestamp: at(i),
      requestVolume: 100,
      avgLatencyMs: 100 + (i % 2), // tiny natural jitter around ~100ms
      p95LatencyMs: 120 + (i % 3),
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0,
    });
  }
  return detector;
}

describe('AnomalyDetector — cold start & baselines', () => {
  it('1. reports INSUFFICIENT_DATA (score null, no events) before minSamples', () => {
    const emissions: string[] = [];
    const detector = new AnomalyDetector({
      minSamples: 4,
      emit: (e) => emissions.push(e.eventType),
    });

    for (let i = 0; i < 3; i += 1) {
      const report = detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: 100,
        p95LatencyMs: 120,
        errorRate: 0.01,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
      assert.equal(report.status, 'INSUFFICIENT_DATA');
      assert.equal(report.score, null);
      assert.deepEqual(report.reasons, []);
    }
    assert.equal(detector.statusOf('payment')?.status, 'INSUFFICIENT_DATA');
    assert.equal(emissions.length, 0);
  });

  it('2. stays NORMAL on stable traffic and produces score 0', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 100,
      p95LatencyMs: 120,
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0,
    });
    assert.equal(report.status, 'NORMAL');
    assert.equal(report.score, 0);
    assert.deepEqual(report.reasons, []);
    assert.ok(report.sampleCount >= 15);
    // Baselines exist for every scored metric.
    for (const metric of SCORED_METRICS) {
      const view = report.baseline[metric];
      assert.ok(view !== undefined && view.sampleCount > 0, `${metric} baseline present`);
    }
  });

  it('detects a latency spike (test 3) with an explanation', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 400, // ~4x baseline of ~100ms
      p95LatencyMs: 450,
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0,
    });
    assert.notEqual(report.status, 'NORMAL');
    assert.ok((report.score ?? 0) > 0.8);
    const top = report.reasons[0];
    assert.ok(top !== undefined);
    assert.ok(top.metric === 'avgLatencyMs' || top.metric === 'p95LatencyMs');
    assert.ok(top.zScore >= 3);
    assert.ok(top.changePercent > 100); // more than doubled vs baseline
  });

  it('4. detects an error-rate spike', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 100,
      p95LatencyMs: 120,
      errorRate: 0.25, // 25x baseline
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0,
    });
    assert.equal(report.status, 'ANOMALOUS');
    assert.ok(report.reasons.some((r) => r.metric === 'errorRate'));
    assert.ok(report.reasons[0]?.metric === 'errorRate'); // dominant explanation
  });

  it('5. detects a timeout-rate spike', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 100,
      p95LatencyMs: 120,
      errorRate: 0.01,
      timeoutRate: 0.3,
      retryRate: 0,
      failoverRate: 0,
    });
    assert.notEqual(report.status, 'NORMAL');
    assert.ok(report.reasons.some((r) => r.metric === 'timeoutRate'));
  });

  it('6. detects a retry-rate spike', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 100,
      p95LatencyMs: 120,
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0.4,
      failoverRate: 0,
    });
    assert.notEqual(report.status, 'NORMAL');
    assert.ok(report.reasons.some((r) => r.metric === 'retryRate'));
  });

  it('7. detects a failover-rate spike', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 100,
      p95LatencyMs: 120,
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0.35,
    });
    assert.notEqual(report.status, 'NORMAL');
    assert.ok(report.reasons.some((r) => r.metric === 'failoverRate'));
  });

  it('8. scores multiple simultaneous anomalies and ranks reasons by z', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 500,
      p95LatencyMs: 550,
      errorRate: 0.2,
      timeoutRate: 0,
      retryRate: 0.3,
      failoverRate: 0,
    });
    assert.equal(report.status, 'ANOMALOUS');
    assert.ok(report.reasons.length >= 2);
    for (let i = 1; i < report.reasons.length; i += 1) {
      const prev = report.reasons[i - 1];
      const curr = report.reasons[i];
      assert.ok(prev && curr && prev.zScore >= curr.zScore, 'reasons sorted by z desc');
    }
  });

  it('9. clamps score to [0,1] even under absurd values', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 1_000_000,
      p95LatencyMs: 2_000_000,
      errorRate: 1,
      timeoutRate: 1,
      retryRate: 1,
      failoverRate: 1,
    });
    assert.ok(report.score !== null && report.score <= 1 && report.score > 0);
  });

  it('10. explanation names the DOMINANT deviation first', () => {
    const detector = warmedDetector(15);
    const report = detector.observe({
      service: 'payment',
      timestamp: at(99),
      requestVolume: 100,
      avgLatencyMs: 900, // massive latency deviation
      p95LatencyMs: 125, // barely moved
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0,
    });
    assert.equal(report.reasons[0]?.metric, 'avgLatencyMs');
    assert.equal(report.status, 'ANOMALOUS');
  });

  it('11. keeps separate per-service baselines (isolation)', () => {
    const detector = new AnomalyDetector();
    // Warm BOTH services with stable traffic.
    for (let i = 0; i < 15; i += 1) {
      for (const service of ['payment', 'ai-primary']) {
        detector.observe({
          service,
          timestamp: at(i),
          requestVolume: 100,
          avgLatencyMs: service === 'payment' ? 100 : 300, // different normals!
          p95LatencyMs: service === 'payment' ? 120 : 350,
          errorRate: 0.01,
          timeoutRate: 0,
          retryRate: 0,
          failoverRate: 0,
        });
      }
    }
    // payment jumps to 400ms -> anomaly FOR payment...
    const paymentReport = detector.observe({
      service: 'payment',
      timestamp: at(50),
      requestVolume: 100,
      avgLatencyMs: 400,
      p95LatencyMs: 420,
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0,
    });
    // ...while ai-primary at its own normal 300ms stays NORMAL.
    const aiReport = detector.observe({
      service: 'ai-primary',
      timestamp: at(50),
      requestVolume: 100,
      avgLatencyMs: 300,
      p95LatencyMs: 350,
      errorRate: 0.01,
      timeoutRate: 0,
      retryRate: 0,
      failoverRate: 0,
    });
    assert.notEqual(paymentReport.status, 'NORMAL');
    assert.equal(aiReport.status, 'NORMAL');
    assert.equal(paymentReport.baseline['avgLatencyMs']?.median, 100);
    assert.equal(aiReport.baseline['avgLatencyMs']?.median, 300);
  });

  it('12a. emits ANOMALY_DETECTED exactly once when degrading', () => {
    const emissions: Array<{ eventType: string; status: string }> = [];
    const detector = new AnomalyDetector({
      minSamples: 6,
      emit: (e) => emissions.push({ eventType: e.eventType, status: e.status }),
    });
    for (let i = 0; i < 6; i += 1) {
      detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: 100,
        p95LatencyMs: 120,
        errorRate: 0.01,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
    }
    // Degrade and STAY degraded across several samples.
    for (let i = 6; i < 10; i += 1) {
      detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: 600,
        p95LatencyMs: 650,
        errorRate: 0.3,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
    }
    const detected = emissions.filter((e) => e.eventType === 'ANOMALY_DETECTED');
    assert.equal(detected.length, 1);
    assert.ok(['WARNING', 'ANOMALOUS'].includes(detected[0]?.status ?? ''));
  });

  it('12b. emits ANOMALY_RESOLVED once on recovery to NORMAL', () => {
    const emissions: string[] = [];
    const detector = new AnomalyDetector({
      minSamples: 6,
      emit: (e) => emissions.push(e.eventType),
    });
    for (let i = 0; i < 6; i += 1) {
      detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: 100,
        p95LatencyMs: 120,
        errorRate: 0.01,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
    }
    for (let i = 6; i < 9; i += 1) {
      detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: 700,
        p95LatencyMs: 750,
        errorRate: 0.01,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
    }
    for (let i = 9; i < 12; i += 1) {
      detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: 100,
        p95LatencyMs: 120,
        errorRate: 0.01,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
    }
    assert.equal(emissions.filter((e) => e === 'ANOMALY_DETECTED').length, 1);
    assert.equal(emissions.filter((e) => e === 'ANOMALY_RESOLVED').length, 1);
    assert.equal(emissions[emissions.length - 1], 'ANOMALY_RESOLVED');
  });

  it('14. survives a throwing emit observer without losing assessments', () => {
    let throwCount = 0;
    const detector = new AnomalyDetector({
      minSamples: 5,
      emit: () => {
        throwCount += 1;
        throw new Error('event sink is down');
      },
    });
    let lastReport = null as ReturnType<AnomalyDetector['observe']> | null;
    for (let i = 0; i < 8; i += 1) {
      lastReport = detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: i < 5 ? 100 : 800,
        p95LatencyMs: i < 5 ? 120 : 850,
        errorRate: 0.01,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
    }
    assert.ok(throwCount >= 1, 'observer was actually invoked');
    assert.notEqual(lastReport?.status, 'NORMAL');
    assert.ok(detector.history('payment').length >= 3);
  });

  it('13. bounds history at maxHistory entries', () => {
    const detector = new AnomalyDetector({ minSamples: 2, maxHistory: 5 });
    for (let i = 0; i < 20; i += 1) {
      detector.observe({
        service: 'payment',
        timestamp: at(i),
        requestVolume: 100,
        avgLatencyMs: 100 + i,
        p95LatencyMs: 120 + i,
        errorRate: 0.01,
        timeoutRate: 0,
        retryRate: 0,
        failoverRate: 0,
      });
    }
    const history = detector.history('payment');
    assert.equal(history.length, 5);
    assert.equal(history[history.length - 1]?.timestamp, at(19));
  });
});

describe('RobustBaseline math', () => {
  it('median: odd/even counts, deterministic ordering', () => {
    const odd = new RobustBaseline(10);
    for (const value of [5, 1, 3]) odd.push(value);
    assert.equal(odd.median(), 3);

    const even = new RobustBaseline(10);
    for (const value of [4, 2, 1, 3]) even.push(value);
    assert.equal(even.median(), 2.5);
  });

  it('MAD is outlier-resistant where stddev would explode', () => {
    const baseline = new RobustBaseline(20);
    for (const value of [100, 101, 99, 100, 102, 98, 100]) baseline.push(value);
    const beforeMad = baseline.mad() ?? -1;

    baseline.push(100_000); // one absurd spike
    assert.equal(baseline.median(), 100); // median unmoved
    const afterView = baseline.view();
    assert.ok(afterView !== null);
    assert.equal(afterView.median, 100);
    assert.ok(Math.abs((afterView.mad ?? -1) - beforeMad) < 5, 'MAD roughly stable');
  });

  it('robustUpperZ is zero at/below median and scales above it', () => {
    const baseline: import('../src/anomaly/anomalyTypes').MetricBaselineView = {
      median: 100,
      mad: 10,
      sampleCount: 30,
    };
    assert.equal(robustUpperZ(80, 'errorRate', baseline), 0);
    assert.equal(robustUpperZ(100, 'errorRate', baseline), 0);
    const z = robustUpperZ(124.82, 'errorRate', baseline); // ~1.4826*10 denom
    assert.ok(z > 1.65 && z < 1.75);
  });

  it('constant-history fallback uses max(5% median, metric floor)', () => {
    const flat: import('../src/anomaly/anomalyTypes').MetricBaselineView = {
      median: 100,
      mad: 0,
      sampleCount: 30,
    };
    const z = robustUpperZ(150, 'avgLatencyMs', flat);
    assert.ok(z > 0);
    // denom = max(100*0.05, 25) = 25 -> z = 2
    assert.ok(Math.abs(z - 2) < 0.001);

    const flatZeroRate: import('../src/anomaly/anomalyTypes').MetricBaselineView = {
      median: 0,
      mad: 0,
      sampleCount: 30,
    };
    // denom floor for rates = 0.02 -> any positive error rate is a huge z
    assert.ok(robustUpperZ(0.05, 'errorRate', flatZeroRate) > 2);
  });
});

describe('anomalyFeatures pure functions', () => {
  it('buildFeatureSnapshot computes correct deltas and clamps rates', () => {
    const current = counterPositionFor(
      makeMetrics('payment', {
        requests: 200,
        successes: 180,
        failures: 10,
        timeouts: 5,
        retries: 40,
        failovers: 20,
        avgLatencyMs: 250,
        p95LatencyMs: 400,
      }),
      'payment',
    );
    assert.ok(current !== null);
    const previous: CounterPosition = {
      requestCount: 100,
      successCount: 100,
      failureCount: 0,
      timeoutCount: 0,
      retryCount: 0,
      failoverCount: 0,
    };
    const feature: FeatureSnapshot | null = buildFeatureSnapshot(
      'payment',
      at(1),
      current,
      previous,
      { avgLatencyMs: 250, p95LatencyMs: 400 },
    );
    assert.ok(feature !== null);
    assert.equal(feature.requestVolume, 100);
    assert.equal(feature.errorRate, Math.round((10 / 100) * 100) / 100);
    assert.equal(feature.timeoutRate, 0.05);
    assert.equal(feature.retryRate, 0.4);
    assert.equal(feature.failoverRate, 0.2);
    assert.equal(feature.avgLatencyMs, 250);
    assert.equal(feature.p95LatencyMs, 400);
  });

  it('idle intervals produce no sample (volume 0)', () => {
    const position = counterPositionFor(makeMetrics('payment', { requests: 100 }), 'payment');
    assert.ok(position !== null);
    assert.equal(
      buildFeatureSnapshot('payment', at(1), position, position, {
        avgLatencyMs: 0,
        p95LatencyMs: 0,
      }),
      null,
    );
  });
});

describe('MetricSampler delta logic', () => {
  function harness(): {
    sampler: MetricSampler;
    setMetrics(next: MetricsSnapshot): void;
    samples: FeatureSnapshot[];
  } {
    const samples: FeatureSnapshot[] = [];
    let metrics = makeMetrics('payment', {});
    const sampler = new MetricSampler({
      getMetrics: () => metrics,
      onSample: (feature) => samples.push(feature),
      intervalMs: 60_000,
    });
    return {
      sampler,
      samples,
      setMetrics(next: MetricsSnapshot) {
        metrics = next;
      },
    };
  }

  it('first tick seeds without emitting; later ticks emit real deltas only', () => {
    const h = harness();
    h.setMetrics(makeMetrics('payment', { requests: 100, successes: 100 }));
    h.sampler.tick();
    assert.equal(h.samples.length, 0, 'seed tick emits nothing');

    h.setMetrics(makeMetrics('payment', { requests: 160, successes: 158 }));
    h.sampler.tick();
    assert.equal(h.samples.length, 1);
    assert.equal(h.samples[0]?.requestVolume, 60);

    h.setMetrics(makeMetrics('payment', { requests: 160, successes: 158 })); // no traffic
    h.sampler.tick();
    assert.equal(h.samples.length, 1, 'idle tick emits nothing');

    h.setMetrics(makeMetrics('payment', { requests: 220, successes: 210, retries: 30 }));
    h.sampler.tick();
    assert.equal(h.samples.length, 2);
    assert.equal(h.samples[1]?.requestVolume, 60);
    assert.equal(h.samples[1]?.retryRate, 0.5);
  });

  it('tick contains failures from a broken metrics source / consumer', () => {
    const failing = new MetricSampler({
      getMetrics: () => {
        throw new Error('metrics exploded');
      },
      onSample: () => undefined,
      intervalMs: 60_000,
    });
    assert.doesNotThrow(() => failing.tick());

    const badConsumer = new MetricSampler({
      getMetrics: () => makeMetrics('payment', { requests: 10, successes: 10 }),
      onSample: () => {
        throw new Error('detector exploded');
      },
      intervalMs: 60_000,
    });
    badConsumer.tick(); // seed
    assert.doesNotThrow(() => badConsumer.tick());
  });

  it('start()/stop() manage the timer without keeping the loop alive', () => {
    const h = harness();
    h.sampler.start(); // seeds immediately
    assert.doesNotThrow(() => h.sampler.start()); // idempotent
    h.sampler.stop();
    assert.doesNotThrow(() => h.sampler.stop()); // idempotent
  });
});

describe('detector configuration validation', () => {
  it('rejects nonsensical thresholds and windows', () => {
    assert.throws(() => new AnomalyDetector({ windowSize: 4 }));
    assert.throws(() => new AnomalyDetector({ windowSize: 20, minSamples: 21 }));
    assert.throws(() => new AnomalyDetector({ scoreWarning: 0.9, scoreAnomalous: 0.5 }));
    assert.throws(() => new AnomalyDetector({ scoreWarning: 0.5, scoreAnomalous: 0.5 }));
    assert.throws(() => new AnomalyDetector({ scoreAnomalous: 1.5 }));
  });

  it('exposes every scored metric in reports once warm', () => {
    const detector = warmedDetector(12, { minSamples: 5 });
    const report = detector.statusOf('payment');
    assert.ok(report !== null);
    const keys = Object.keys(report.baseline);
    for (const metric of [
      'avgLatencyMs',
      'p95LatencyMs',
      'errorRate',
      'timeoutRate',
      'retryRate',
      'failoverRate',
    ]) {
      assert.ok(keys.includes(metric), `${metric} in baseline map`);
    }
    void (null as unknown as MetricKey);
  });
});
