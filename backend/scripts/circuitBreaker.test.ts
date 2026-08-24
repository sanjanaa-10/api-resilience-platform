/**
 * Circuit breaker unit tests — Node built-in test runner, zero new deps.
 * Run: npm test   (node --import tsx --test)
 *
 * Determinism: the breaker's clock is injected (`now`), so OPEN cool-off
 * and lazy HALF_OPEN transitions are tested by advancing a virtual clock —
 * no real sleeping anywhere.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  countsAsCircuitFailure,
} from '../src/services/circuitBreaker.service';

function makeBreaker(opts?: Partial<{ threshold: number; openMs: number; maxProbes: number }>) {
  let t = 1_000_000; // virtual epoch ms
  const now = (): number => t;
  const advance = (ms: number): void => {
    t += ms;
  };
  const cb = new CircuitBreaker(
    {
      failureThreshold: opts?.threshold ?? 3,
      openDurationMs: opts?.openMs ?? 10_000,
      halfOpenMaxRequests: opts?.maxProbes ?? 1,
    },
    now,
  );
  return { cb, advance };
}

describe('circuit breaker state machine', () => {
  it('starts CLOSED and admits traffic', () => {
    const { cb } = makeBreaker();
    const d = cb.canRequest('ai-primary');
    assert.equal(d.allowed, true);
    assert.equal(d.state, 'CLOSED');
    assert.equal(d.isProbe, false);
  });

  it('CLOSED -> OPEN exactly when consecutive failures reach the threshold', () => {
    const { cb } = makeBreaker({ threshold: 3 });
    for (let i = 0; i < 2; i++) {
      assert.equal(cb.canRequest('ai-primary').allowed, true);
      cb.recordFailure('ai-primary');
    }
    assert.equal(cb.snapshot('ai-primary').state, 'CLOSED');
    assert.equal(cb.snapshot('ai-primary').failureCount, 2);

    // 3rd consecutive logical-request failure trips it
    assert.equal(cb.canRequest('ai-primary').allowed, true);
    cb.recordFailure('ai-primary');
    assert.equal(cb.snapshot('ai-primary').state, 'OPEN');
    assert.equal(cb.snapshot('ai-primary').openedAt !== null, true);
  });

  it('success resets the consecutive failure counter (CLOSED)', () => {
    const { cb } = makeBreaker({ threshold: 3 });
    cb.recordFailure('ai-primary');
    cb.recordFailure('ai-primary');
    assert.equal(cb.canRequest('ai-primary').allowed, true);
    cb.recordSuccess('ai-primary');
    assert.equal(cb.snapshot('ai-primary').state, 'CLOSED');
    assert.equal(cb.snapshot('ai-primary').failureCount, 0);
  });

  it('fail-fast while OPEN: rejected instantly WITHOUT contacting upstream logic', () => {
    const { cb } = makeBreaker({ threshold: 1 });
    cb.canRequest('ai-primary');
    cb.recordFailure('ai-primary'); // trip immediately
    const startedAt = Date.now();
    const d = cb.canRequest('ai-primary');
    assert.equal(d.allowed, false);
    assert.equal(d.state, 'OPEN');
    assert.ok(Date.now() - startedAt < 5, 'rejection must be pure memory work');
  });

  it('fail-fast rejections never count as circuit failures', () => {
    const { cb } = makeBreaker({ threshold: 2 });
    cb.canRequest('ai-primary');
    cb.recordFailure('ai-primary');
    cb.recordFailure('ai-primary'); // OPEN
    const before = cb.snapshot('ai-primary');
    for (let i = 0; i < 50; i++) cb.canRequest('ai-primary'); // storm of rejected requests
    assert.deepEqual(cb.snapshot('ai-primary'), before); // untouched
  });

  it('straggler failures recorded while OPEN neither inflate nor extend the cool-off', () => {
    const { cb, advance } = makeBreaker({ threshold: 1, openMs: 10_000 });
    cb.canRequest('ai-primary');
    cb.recordFailure('ai-primary');
    const openedAtBefore = cb.snapshot('ai-primary').openedAt;
    advance(9_999); // just before cool-off ends
    cb.recordFailure('ai-primary'); // late arrival from before the trip
    cb.recordFailure('ai-primary');
    assert.equal(cb.snapshot('ai-primary').openedAt, openedAtBefore);
    assert.equal(cb.canRequest('ai-primary').allowed, false); // still cooling off
  });

  it('OPEN -> HALF_OPEN lazily once openDurationMs elapses', () => {
    const { cb, advance } = makeBreaker({ threshold: 1, openMs: 10_000 });
    cb.canRequest('ai-primary');
    cb.recordFailure('ai-primary');
    assert.equal(cb.canRequest('ai-primary').allowed, false);
    advance(10_000); // cool-off elapsed; NO timer ran — nothing happened yet
    assert.equal(cb.snapshot('ai-primary').state, 'OPEN');
    const d = cb.canRequest('ai-primary'); // arriving request triggers the transition
    assert.equal(d.allowed, true);
    assert.equal(d.state, 'HALF_OPEN');
    assert.equal(d.isProbe, true);
  });

  it('only ONE half-open probe is admitted at a time (halfOpenMaxRequests=1)', () => {
    const { cb, advance } = makeBreaker({ threshold: 1, openMs: 1_000 });
    cb.canRequest('ai-primary');
    cb.recordFailure('ai-primary');
    advance(1_000);
    const probe = cb.canRequest('ai-primary');
    assert.equal(probe.isProbe, true);
    // Concurrent requests racing in BEFORE the probe outcome is recorded:
    // every one of them must be rejected — no second probe possible.
    for (let i = 0; i < 20; i++) {
      const d = cb.canRequest('ai-primary');
      assert.equal(d.allowed, false);
      assert.equal(d.isProbe, false);
    }
  });

  it('probe success: HALF_OPEN -> CLOSED, counters fully reset', () => {
    const { cb, advance } = makeBreaker({ threshold: 2 });
    for (let i = 0; i < 2; i++) {
      cb.canRequest('ai-primary');
      cb.recordFailure('ai-primary');
    }
    advance(10_000);
    assert.equal(cb.canRequest('ai-primary').isProbe, true);
    cb.recordSuccess('ai-primary');
    const snap = cb.snapshot('ai-primary');
    assert.equal(snap.state, 'CLOSED');
    assert.equal(snap.failureCount, 0);
    assert.equal(snap.openedAt, null);
    assert.equal(cb.canRequest('ai-primary').allowed, true);
    assert.equal(cb.canRequest('ai-primary').state, 'CLOSED');
  });

  it('probe failure: HALF_OPEN -> OPEN again with a fresh cool-off window', () => {
    const { cb, advance } = makeBreaker({ threshold: 1, openMs: 10_000 });
    cb.canRequest('ai-primary');
    cb.recordFailure('ai-primary');
    advance(10_000);
    assert.equal(cb.canRequest('ai-primary').isProbe, true);
    cb.recordFailure('ai-primary'); // recovery attempt failed
    assert.equal(cb.snapshot('ai-primary').state, 'OPEN');
    // Fresh full cool-off: not yet eligible again
    advance(9_999);
    assert.equal(cb.canRequest('ai-primary').allowed, false);
    advance(1);
    assert.equal(cb.canRequest('ai-primary').isProbe, true);
  });

  it('per-service isolation: one OPEN circuit never affects other services', () => {
    const { cb } = makeBreaker({ threshold: 1 });
    cb.canRequest('ai-primary');
    cb.recordFailure('ai-primary'); // ai -> OPEN
    assert.equal(cb.snapshot('ai-primary').state, 'OPEN');

    const payment = cb.canRequest('payment');
    assert.equal(payment.allowed, true);
    assert.equal(payment.state, 'CLOSED');
    assert.equal(cb.snapshot('payment').failureCount, 0);

    // payment failing independently reaches its own threshold
    for (let i = 0; i < 1; i++) cb.recordFailure('payment');
    assert.equal(cb.snapshot('payment').state, 'OPEN');
    assert.equal(cb.snapshot('ai-primary').state, 'OPEN'); // unrelated transitions
  });
});

describe('countsAsCircuitFailure classification', () => {
  it('counts network failures, timeouts and 502/503/504', () => {
    assert.equal(countsAsCircuitFailure({ kind: 'unreachable' }), true);
    assert.equal(countsAsCircuitFailure({ kind: 'timeout' }), true);
    assert.equal(countsAsCircuitFailure({ kind: 'upstream-error', status: 502 }), true);
    assert.equal(countsAsCircuitFailure({ kind: 'upstream-error', status: 503 }), true);
    assert.equal(countsAsCircuitFailure({ kind: 'upstream-error', status: 504 }), true);
  });

  it('never counts 4xx, 500-class bugs, invalid responses or successes', () => {
    assert.equal(countsAsCircuitFailure({ kind: 'upstream-error', status: 400 }), false);
    assert.equal(countsAsCircuitFailure({ kind: 'upstream-error', status: 404 }), false);
    assert.equal(countsAsCircuitFailure({ kind: 'upstream-error', status: 500 }), false);
    assert.equal(countsAsCircuitFailure({ kind: 'invalid-response', status: 200 }), false);
    assert.equal(countsAsCircuitFailure({ kind: 'success', status: 200 }), false);
  });
});
