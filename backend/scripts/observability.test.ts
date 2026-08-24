/**
 * Observability unit tests — Node built-in test runner.
 * Run: npm test
 *
 * Covers the full Step 8 surface with deterministic (injected-clock) time:
 *   1.  typed event creation + defaults
 *   2.  bounded event store ordering/capacity/filtering
 *   3.  metrics counters + average/p95 latency + window eviction
 *   4.  incident rules: threshold start, circuit start, dedup/attach,
 *       escalation, timeline, resolution (circuit + quiet period),
 *       affected-request accounting
 *   5.  facade fan-out + broken-sink isolation
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createResilienceEvent,
  type ResilienceEvent,
} from '../src/observability/events';
import { ResilienceEventStore } from '../src/observability/eventStore.service';
import { MetricsCollector } from '../src/observability/metricsCollector.service';
import { IncidentAggregator } from '../src/observability/incidentAggregator.service';
import { ObservabilityService } from '../src/observability/observability.service';

function makeEvent(input: {
  eventType: ResilienceEvent['eventType'];
  service: string;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  severity?: ResilienceEvent['severity'];
}): ResilienceEvent {
  return createResilienceEvent({
    eventType: input.eventType,
    service: input.service,
    message: `${input.eventType} on ${input.service}`,
    requestId: input.requestId ?? undefined,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    metadata: input.metadata,
  });
}

// ─── 1. Event model ───────────────────────────────────────────────────────────

describe('event model', () => {
  it('fills deterministic defaults for every field', () => {
    const event = createResilienceEvent({
      eventType: 'UPSTREAM_TIMEOUT',
      service: 'ai-primary',
      message: 'timed out',
    });
    assert.ok(event.eventId.length > 0);
    assert.equal(Number.isNaN(Date.parse(event.timestamp)), false);
    assert.equal(event.severity, 'WARNING'); // UPSTREAM_TIMEOUT default
    assert.equal(event.requestId, null);
    assert.deepEqual(event.metadata, {});
  });

  it('respects explicit severity override and requestId', () => {
    const event = createResilienceEvent({
      eventType: 'HEALTH_CHANGED',
      service: 'payment',
      severity: 'WARNING',
      requestId: 'req-1',
      metadata: { to: 'unhealthy' },
    });
    assert.equal(event.severity, 'WARNING');
    assert.equal(event.requestId, 'req-1');
    assert.deepEqual(event.metadata, { to: 'unhealthy' });
  });
});

// ─── 2. Event store ──────────────────────────────────────────────────────────

describe('event store', () => {
  it('appends chronologically and lists newest-first', () => {
    const store = new ResilienceEventStore(100);
    const a = makeEvent({ eventType: 'REQUEST_STARTED', service: 'payment' });
    const b = makeEvent({ eventType: 'REQUEST_COMPLETED', service: 'payment' });
    store.append(a);
    store.append(b);
    const listed = store.list();
    assert.equal(listed[0]?.eventId, b.eventId);
    assert.equal(listed[1]?.eventId, a.eventId);
  });

  it('keeps only the newest events at capacity', () => {
    const store = new ResilienceEventStore(3);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const event = makeEvent({ eventType: 'REQUEST_STARTED', service: 'payment' });
      ids.push(event.eventId);
      store.append(event);
    }
    assert.equal(store.size, 3);
    const listed = store.list();
    assert.deepEqual(
      listed.map((event) => event.eventId),
      [ids[4], ids[3], ids[2]],
    );
  });

  it('filters by service, type and severity and honors limit', () => {
    const store = new ResilienceEventStore(100);
    store.append(makeEvent({ eventType: 'REQUEST_FAILED', service: 'ai-primary' }));
    store.append(makeEvent({ eventType: 'RATE_LIMITED', service: 'gateway' }));
    store.append(makeEvent({ eventType: 'REQUEST_FAILED', service: 'payment' }));
    store.append(makeEvent({ eventType: 'CIRCUIT_OPENED', service: 'ai-primary', severity: 'CRITICAL' }));

    assert.equal(store.list({ service: 'ai-primary' }).length, 2);
    assert.equal(store.list({ eventType: 'REQUEST_FAILED' }).length, 2);
    assert.equal(store.list({ severity: 'CRITICAL' }).length, 1);
    assert.equal(store.list({ service: 'ai-primary', limit: 1 }).length, 1);
    assert.equal(store.list({ service: 'nope' }).length, 0);
  });
});

// ─── 3. Metrics collector ────────────────────────────────────────────────────

describe('metrics collector', () => {
  it('counts totals and per-service counters by event type', () => {
    const metrics = new MetricsCollector(200);
    metrics.observe(makeEvent({ eventType: 'REQUEST_STARTED', service: 'ai-primary' }));
    metrics.observe(makeEvent({ eventType: 'RETRY_ATTEMPT', service: 'ai-primary' }));
    metrics.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary' }));
    metrics.observe(makeEvent({ eventType: 'FAILOVER_COMPLETED', service: 'ai-primary' }));
    metrics.observe(
      makeEvent({ eventType: 'REQUEST_COMPLETED', service: 'ai-fallback', metadata: { durationMs: 120 } }),
    );
    metrics.observe(makeEvent({ eventType: 'CIRCUIT_OPENED', service: 'ai-primary' }));

    const snapshot = metrics.getSnapshot();
    assert.equal(snapshot.totals.requestCount, 1);
    assert.equal(snapshot.totals.successCount, 1);
    assert.equal(snapshot.totals.retryCount, 1);
    assert.equal(snapshot.totals.timeoutCount, 1);
    assert.equal(snapshot.totals.failoverCount, 1);
    assert.equal(snapshot.totals.circuitOpenCount, 1);

    const primary = snapshot.services['ai-primary'];
    assert.equal(primary?.failureCount, 0);
    assert.equal(primary?.retryCount, 1);
    const fallback = snapshot.services['ai-fallback'];
    assert.equal(fallback?.successCount, 1);
  });

  it('computes average latency over recorded samples', () => {
    const metrics = new MetricsCollector(200);
    for (const ms of [100, 200, 300]) {
      metrics.observe(
        makeEvent({ eventType: 'REQUEST_COMPLETED', service: 'payment', metadata: { durationMs: ms } }),
      );
    }
    const payment = metrics.getSnapshot().services['payment'];
    assert.equal(payment?.averageLatencyMs, 200);
    assert.equal(payment?.p95LatencyMs, 300); // ceil(.95*3)-1 = index 2
  });

  it('evicts old samples once the latency window is exceeded', () => {
    const metrics = new MetricsCollector(50);
    for (let ms = 1; ms <= 100; ms += 1) {
      metrics.observe(
        makeEvent({ eventType: 'REQUEST_COMPLETED', service: 'payment', metadata: { durationMs: ms } }),
      );
    }
    const payment = metrics.getSnapshot().services['payment'];
    // Window retains 51..100 -> avg 75.5, p95 = sorted[ceil(47.5)-1] = 98.
    assert.equal(payment?.averageLatencyMs, 75.5);
    assert.equal(payment?.p95LatencyMs, 98);
  });
});

// ─── 4. Incident aggregator ──────────────────────────────────────────────────

interface Clock { value: number }

function freshAggregator(clock: Clock, overrides: Partial<ConstructorParameters<typeof IncidentAggregator>[0]> = {}): IncidentAggregator {
  return new IncidentAggregator({
    failureThreshold: 3,
    lookbackMs: 60_000,
    recoveryQuietMs: 10_000,
    maxResolvedIncidents: 100,
    now: () => clock.value,
    ...overrides,
  });
}

describe('incident aggregator', () => {
  it('does NOT open an incident below the failure threshold', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r1' }));
    clock.value += 1_000;
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r2' }));
    assert.equal(aggregator.active().length, 0);
    assert.equal(aggregator.list().length, 0);
  });

  it('opens a WARNING incident when the threshold is reached in-window', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    ['r1', 'r2', 'r3'].forEach((requestId, index) => {
      if (index > 0) clock.value += 1_000;
      aggregator.observe(
        makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId }),
      );
    });
    const active = aggregator.active();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.service, 'ai-primary');
    assert.equal(active[0]?.status, 'ACTIVE');
    assert.equal(active[0]?.severity, 'WARNING');
    assert.equal(active[0]?.affectedRequests, 3);
    assert.equal(active[0]?.eventCount, 3);
  });

  it('ignores signals that fell out of the lookback window', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r1' }));
    clock.value += 61_000; // first signal expired
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r2' }));
    clock.value += 1_000;
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r3' }));
    assert.equal(aggregator.active().length, 0);
  });

  it('starts IMMEDIATELY on CIRCUIT_OPENED with CRITICAL severity', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    aggregator.observe(makeEvent({ eventType: 'CIRCUIT_OPENED', service: 'payment', requestId: 'r1' }));
    const active = aggregator.active();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.severity, 'CRITICAL');
    assert.equal(active[0]?.circuitOpened, true);
  });

  it('attaches subsequent events without duplicating incidents, escalating on failover', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    aggregator.observe(makeEvent({ eventType: 'CIRCUIT_OPENED', service: 'ai-primary', requestId: 'r1' }));
    aggregator.observe(makeEvent({ eventType: 'CIRCUIT_HALF_OPEN', service: 'ai-primary' })); // context
    aggregator.observe(makeEvent({ eventType: 'CIRCUIT_OPENED', service: 'ai-primary', requestId: 'r2' })); // attach
    let active = aggregator.active();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.eventCount, 3);
    assert.equal(active[0]?.severity, 'CRITICAL');

    aggregator.observe(
      makeEvent({ eventType: 'FAILOVER_STARTED', service: 'ai-primary', requestId: 'r3' }),
    );
    active = aggregator.active();
    assert.equal(active.length, 1); // no duplicate incident
    assert.equal(active[0]?.failoverOccurred, true);
    assert.equal(active[0]?.severity, 'CRITICAL');
  });

  it('records context signals (retries) on the ACTIVE timeline', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'payment', requestId: 'r1' }));
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'payment', requestId: 'r2' }));
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'payment', requestId: 'r3' }));
    aggregator.observe(makeEvent({ eventType: 'RETRY_ATTEMPT', service: 'payment', requestId: 'r4' }));
    const incident = aggregator.active()[0];
    assert.equal(incident?.timeline.some((entry) => entry.eventType === 'RETRY_ATTEMPT'), true);
  });

  it('builds a chronological timeline with all required fields', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    const sequence: ResilienceEvent[] = [
      makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r1' }),
      makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r2' }),
      makeEvent({ eventType: 'RETRY_ATTEMPT', service: 'ai-primary', requestId: 'r2' }),
      makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'ai-primary', requestId: 'r3' }),
    ];
    for (const event of sequence) aggregator.observe(event);

    const timeline = aggregator.active()[0]?.timeline ?? [];
    assert.equal(timeline.length, 4);
    for (const entry of timeline) {
      assert.equal(Number.isNaN(Date.parse(entry.timestamp)), false);
      assert.equal(typeof entry.message, 'string');
    }
    assert.deepEqual(
      timeline.map((entry) => entry.eventType),
      ['UPSTREAM_TIMEOUT', 'UPSTREAM_TIMEOUT', 'RETRY_ATTEMPT', 'UPSTREAM_TIMEOUT'],
    );
  });

  it('counts affectedRequests as DISTINCT requests with failure signals', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'payment', requestId: 'same' }));
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'payment', requestId: 'same' }));
    aggregator.observe(makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'payment', requestId: 'other' }));
    const incident = aggregator.active()[0];
    assert.equal(incident?.affectedRequests, 2);
    assert.equal(incident?.eventCount, 3);
  });

  it('resolves IMMEDIATELY on CIRCUIT_CLOSED and keeps the resolved record', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock);
    aggregator.observe(makeEvent({ eventType: 'CIRCUIT_OPENED', service: 'ai-primary', requestId: 'r1' }));
    const id = aggregator.active()[0]?.incidentId;
    assert.ok(id);

    clock.value += 500;
    aggregator.observe(makeEvent({ eventType: 'CIRCUIT_CLOSED', service: 'ai-primary' }));

    assert.equal(aggregator.active().length, 0);
    const resolved = aggregator.get(id ?? '');
    assert.equal(resolved?.status, 'RESOLVED');
    assert.ok(resolved?.endedAt !== null);
    assert.match(resolved?.summary ?? '', /circuit closed/);
    // Unknown ids return null rather than throwing.
    assert.equal(aggregator.get('does-not-exist'), null);
  });

  it('resolves via quiet period after failures stop (lazy, clock-driven)', () => {
    const clock: Clock = { value: 1_000_000 };
    const aggregator = freshAggregator(clock, { recoveryQuietMs: 5_000 });
    for (const requestId of ['r1', 'r2', 'r3']) {
      aggregator.observe(
        makeEvent({ eventType: 'UPSTREAM_TIMEOUT', service: 'notification', requestId }),
      );
    }
    assert.equal(aggregator.active().length, 1);

    clock.value += 4_999; // still inside the quiet window
    aggregator.observe(makeEvent({ eventType: 'REQUEST_COMPLETED', service: 'notification', requestId: 'ok1' }));
    assert.equal(aggregator.active().length, 1);

    clock.value += 1; // quiet period now satisfied
    aggregator.observe(makeEvent({ eventType: 'REQUEST_COMPLETED', service: 'notification', requestId: 'ok2' }));
    assert.equal(aggregator.active().length, 0);
    const resolved = aggregator.list().find((incident) => incident.service === 'notification');
    assert.equal(resolved?.status, 'RESOLVED');
    assert.match(resolved?.summary ?? '', /quiet period/);
  });
});

// ─── 5. Facade ───────────────────────────────────────────────────────────────

describe('observability facade', () => {
  function freshFacade(): ObservabilityService {
    return new ObservabilityService({
      eventCapacity: 50,
      latencyWindow: 20,
      incident: {
        failureThreshold: 3,
        lookbackMs: 60_000,
        recoveryQuietMs: 10_000,
        maxResolvedIncidents: 10,
      },
    });
  }

  it('fans one record() out to store, metrics and incidents', () => {
    const observability = freshFacade();
    const event = observability.record({
      eventType: 'REQUEST_COMPLETED',
      service: 'payment',
      message: 'served',
      requestId: 'req-9',
      metadata: { durationMs: 42 },
    });
    assert.ok(event);
    assert.equal(observability.store.size, 1);
    assert.equal(observability.getMetrics().services['payment']?.successCount, 1);
    assert.equal(observability.getMetrics().services['payment']?.p95LatencyMs, 42);
    assert.equal(observability.listEvents({ requestId: undefined as unknown as string }).length, 1);

    // Circuit events flow through the same single entry point.
    observability.record({
      eventType: 'CIRCUIT_OPENED',
      service: 'payment',
      message: 'tripped',
      requestId: 'req-10',
    });
    const active = observability.listActiveIncidents();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.service, 'payment');
    assert.ok(active[0]?.incidentId.length > 0);
  });

  it('a broken sink never breaks recording nor the other sinks', () => {
    const observability = freshFacade();
    // Simulate a corrupted store: append explodes on every call.
    (observability.store as unknown as { append: () => void }).append = () => {
      throw new Error('store exploded');
    };

    const event = observability.record({
      eventType: 'REQUEST_COMPLETED',
      service: 'payment',
      message: 'still counted',
      metadata: { durationMs: 7 },
    });

    assert.ok(event); // caller unaffected
    assert.equal(observability.store.size, 0); // sink degraded...
    assert.equal(observability.getMetrics().services['payment']?.successCount, 1); // ...others fine
    assert.doesNotThrow(() =>
      observability.record({ eventType: 'CIRCUIT_OPENED', service: 'payment', message: 'x' }),
    );
    assert.equal(observability.listActiveIncidents().length, 1);
  });

  it('query helpers expose consistent read views', () => {
    const observability = freshFacade();
    observability.record({ eventType: 'CIRCUIT_OPENED', service: 'payment', message: 'x', requestId: 'q1' });
    const all = observability.listIncidents();
    assert.equal(all.length, 1);
    const id = all[0]?.incidentId;
    assert.ok(id);
    assert.equal(observability.getIncident(id ?? '')?.status, 'ACTIVE');
    assert.equal(observability.getIncident('missing'), null);
    assert.equal(observability.listEvents({ service: 'gateway' }).length, 0);
    assert.equal(observability.listEvents({}).length, 1);
  });
});
