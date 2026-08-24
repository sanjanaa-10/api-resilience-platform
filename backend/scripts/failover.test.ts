/**
 * Failover orchestrator unit tests — Node built-in test runner, zero deps.
 * Run: npm test   (node --import tsx --test)
 *
 * Strategy: REAL CircuitBreaker instances (real state machine, no clock
 * travel needed) + a FAKE provider executor returning canned outcomes.
 * The executor boundary is the seam that makes orchestration deterministic:
 * each call represents one provider's entire bounded retry loop.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAX_FAILOVERS,
  buildFailoverMetadata,
  executeWithFailover,
  isFailoverEligible,
  type FailoverDeps,
  type FailoverRequestContext,
  type ProviderExecutor,
} from '../src/services/failover.service';
import { CircuitBreaker } from '../src/services/circuitBreaker.service';
import type {
  ProviderGroup,
  ProxyBusinessResult,
  ProxyOutcome,
  ServiceName,
  ServiceRegistration,
} from '../src/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function reg(name: ServiceName): ServiceRegistration {
  return {
    name,
    displayName: name,
    baseUrl: `http://${name}`,
    healthPath: '/health',
    gatewayPath: `/${name}`,
    targetPath: '/test',
  };
}

/** Three-provider group proves budget behavior beyond a single fallback. */
function makeGroup(names: ServiceName[]): ProviderGroup {
  return {
    id: 'test-group',
    displayName: 'Test group',
    gatewayPath: '/test',
    targetPath: '/test',
    providers: names.map(reg),
  };
}

const ok = (status = 200): ProxyOutcome => ({
  kind: 'success',
  status,
  body: { servedBy: 'someone' },
  durationMs: 1,
  upstreamRequestId: null,
});
const httpError = (status: number): ProxyOutcome => ({
  kind: 'upstream-error',
  status,
  body: {},
  durationMs: 1,
  upstreamRequestId: null,
});
const TIMEOUT: ProxyOutcome = { kind: 'timeout', durationMs: 5 };
const UNREACHABLE: ProxyOutcome = {
  kind: 'unreachable',
  durationMs: 2,
  errorMessage: 'ECONNREFUSED',
};

function makeResult(outcome: ProxyOutcome): ProxyBusinessResult {
  return {
    outcome,
    retry: { attempts: 1, retries: 0, totalDurationMs: outcome.durationMs, attemptsLog: [] },
  };
}

interface World {
  /** Outcomes served per provider, consumed in order by the fake executor. */
  script: Map<ServiceName, ProxyOutcome[]>;
  /** Providers the health gate considers healthy. */
  healthy: Set<ServiceName>;
  calls: ServiceName[];
}

function makeWorld(providerHealth: ServiceName[]): {
  world: World;
  deps: FailoverDeps;
  request: FailoverRequestContext;
} {
  const world: World = {
    script: new Map(),
    healthy: new Set(providerHealth),
    calls: [],
  };
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: 100, // high default: individual tests trip explicitly
    openDurationMs: 10_000,
    halfOpenMaxRequests: 1,
  });
  const deps: FailoverDeps = {
    circuitBreaker,
    isProviderHealthy: (name) => world.healthy.has(name),
  };
  const request: FailoverRequestContext = {
    requestId: 'req-test',
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  };
  return { world, deps, request };
}

/**
 * Fake executor: pops the next scripted outcome for this provider.
 * A provider with NO scripted outcomes succeeds — keeps fixtures terse.
 */
function scriptedExecutor(world: World): ProviderExecutor {
  return async (entry) => {
    world.calls.push(entry.name);
    const queue = world.script.get(entry.name);
    const outcome = queue !== undefined && queue.length > 0 ? queue.shift() : ok();
    return makeResult(outcome ?? ok());
  };
}

// ─── Classification ──────────────────────────────────────────────────────────

describe('isFailoverEligible classification', () => {
  it('fails over on transient conditions: timeout, network loss, 502/503/504', () => {
    assert.equal(isFailoverEligible(TIMEOUT), true);
    assert.equal(isFailoverEligible(UNREACHABLE), true);
    assert.equal(isFailoverEligible(httpError(502)), true);
    assert.equal(isFailoverEligible(httpError(503)), true);
    assert.equal(isFailoverEligible(httpError(504)), true);
  });

  it('never fails over on client errors, deterministic bugs or malformed bodies', () => {
    assert.equal(isFailoverEligible(httpError(400)), false);
    assert.equal(isFailoverEligible(httpError(401)), false);
    assert.equal(isFailoverEligible(httpError(403)), false);
    assert.equal(isFailoverEligible(httpError(404)), false);
    assert.equal(isFailoverEligible(httpError(500)), false); // bug, not availability
    assert.equal(
      isFailoverEligible({ kind: 'invalid-response', status: 200, durationMs: 1, bodySnippet: '<html>' }),
      false,
    );
    assert.equal(isFailoverEligible(ok()), false);
  });
});

// ─── Orchestration ───────────────────────────────────────────────────────────

describe('executeWithFailover orchestration', () => {
  it('T1 primary success: fallback untouched, metadata says no failover', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback']);
    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.deepEqual(world.calls, ['ai-primary']);
    assert.equal(execution.failoverOccurred, false);
    assert.equal(execution.selectedProvider, 'ai-primary');
    assert.equal(execution.outcome?.kind, 'success');
    const meta = buildFailoverMetadata(execution);
    assert.deepEqual(meta, { occurred: false, selectedProvider: 'ai-primary' });
  });

  it('T2 primary timeout -> fallback success, reason + metadata recorded', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback']);
    world.script.set('ai-primary', [TIMEOUT]);

    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.deepEqual(world.calls, ['ai-primary', 'ai-fallback']);
    assert.equal(execution.failoverOccurred, true);
    assert.equal(execution.selectedProvider, 'ai-fallback');
    assert.equal(execution.failoverReason, 'UPSTREAM_TIMEOUT');
    assert.equal(execution.outcome?.kind, 'success');
    const meta = buildFailoverMetadata(execution);
    assert.equal(meta.occurred, true);
    assert.equal(meta.primary, 'ai-primary');
    assert.equal(meta.reason, 'UPSTREAM_TIMEOUT');
    // Exactly ONE failure recorded against the primary despite its retries;
    // exactly ONE success for the fallback.
    assert.equal(deps.circuitBreaker.snapshot('ai-primary').failureCount, 1);
    assert.equal(deps.circuitBreaker.snapshot('ai-fallback').failureCount, 0);
  });

  it('T3 network loss maps to NETWORK_UNAVAILABLE and still fails over', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback']);
    world.script.set('ai-primary', [UNREACHABLE]);

    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);
    assert.equal(execution.failoverOccurred, true);
    assert.equal(execution.failoverReason, 'NETWORK_UNAVAILABLE');
  });

  it('T4 budget: with maxFailovers=1 a third provider is never tried', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback', 'notification']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback', 'notification']);
    world.script.set('ai-primary', [TIMEOUT]);
    world.script.set('ai-fallback', [httpError(503)]);

    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.deepEqual(world.calls, ['ai-primary', 'ai-fallback']); // notification NEVER called
    assert.equal(execution.selectedProvider, 'ai-fallback');
    assert.equal(execution.attempts.at(-1)?.provider, 'notification');
    assert.equal(execution.attempts.at(-1)?.skipReason, 'BUDGET_EXHAUSTED');
    assert.equal(DEFAULT_MAX_FAILOVERS, 1); // production budget pinned
  });

  it('T5 primary circuit OPEN: skipped WITHOUT contacting it, fallback serves', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback']);
    // Dedicated breaker with threshold 1 so one failure trips it.
    const strictBreaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 60_000 });
    strictBreaker.canRequest('ai-primary');
    strictBreaker.recordFailure('ai-primary'); // OPEN
    assert.equal(strictBreaker.snapshot('ai-primary').state, 'OPEN');

    const execution = await executeWithFailover(
      group,
      request,
      scriptedExecutor(world),
      { ...deps, circuitBreaker: strictBreaker },
    );

    assert.deepEqual(world.calls, ['ai-fallback']); // primary never contacted
    const primaryAttempt = execution.attempts[0];
    assert.equal(primaryAttempt.provider, 'ai-primary');
    assert.equal(primaryAttempt.attempted, false);
    assert.equal(primaryAttempt.skipReason, 'CIRCUIT_OPEN');
    assert.equal(execution.failoverOccurred, true);
    assert.equal(execution.failoverReason, 'CIRCUIT_OPEN');
    // The rejection itself recorded NOTHING against the primary.
    assert.equal(strictBreaker.snapshot('ai-primary').failureCount, 1); // unchanged from the trip
  });

  it('T6 unhealthy fallback blocks failover: original failure returned, occurred=false', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary']); // fallback NOT healthy
    world.script.set('ai-primary', [TIMEOUT]);

    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.deepEqual(world.calls, ['ai-primary']);
    assert.equal(execution.selectedProvider, 'ai-primary');
    assert.equal(execution.failoverOccurred, false);
    assert.equal(execution.outcome?.kind, 'timeout');
    assert.equal(execution.attempts[1]?.skipReason, 'UNHEALTHY');
  });

  it('T7 non-eligible failure (404) stops the chain: no fallback attempt', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback']);
    world.script.set('ai-primary', [httpError(404)]);

    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.deepEqual(world.calls, ['ai-primary']);
    assert.equal(execution.selectedProvider, 'ai-primary');
    assert.equal(execution.failoverOccurred, false);
    assert.equal(execution.outcome?.kind, 'upstream-error');
    assert.equal(execution.retry?.attempts, 1);
  });

  it('T8 every provider failing yields the FALLBACK failure as final outcome', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback']);
    world.script.set('ai-primary', [TIMEOUT]);
    world.script.set('ai-fallback', [httpError(503)]);

    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.deepEqual(world.calls, ['ai-primary', 'ai-fallback']);
    assert.equal(execution.failoverOccurred, true); // request WAS moved off primary
    assert.equal(execution.selectedProvider, 'ai-fallback');
    // Reason explains why we LEFT THE PRIMARY — fallback's own 503 never overwrites it.
    assert.equal(execution.failoverReason, 'UPSTREAM_TIMEOUT');
    assert.equal(execution.outcome?.kind, 'upstream-error');
    // Each provider's breaker saw exactly its own single final outcome.
    assert.equal(deps.circuitBreaker.snapshot('ai-primary').failureCount, 1);
    assert.equal(deps.circuitBreaker.snapshot('ai-fallback').failureCount, 1);
  });

  it('singleton group behaves like direct proxying: failure returned, no metadata drama', async () => {
    const group = makeGroup(['payment']);
    const { world, deps, request } = makeWorld(['payment']);
    world.script.set('payment', [TIMEOUT]);

    const execution = await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.deepEqual(world.calls, ['payment']);
    assert.equal(execution.selectedProvider, 'payment');
    assert.equal(execution.failoverOccurred, false);
    assert.equal(execution.outcome?.kind, 'timeout');
    assert.deepEqual(buildFailoverMetadata(execution), {
      occurred: false,
      selectedProvider: 'payment',
    });
  });

  it('per-provider circuits stay isolated across failover activity', async () => {
    const group = makeGroup(['ai-primary', 'ai-fallback']);
    const { world, deps, request } = makeWorld(['ai-primary', 'ai-fallback']);
    world.script.set('ai-primary', [TIMEOUT]);

    await executeWithFailover(group, request, scriptedExecutor(world), deps);

    assert.equal(deps.circuitBreaker.snapshot('ai-primary').state, 'CLOSED'); // threshold 100
    assert.equal(deps.circuitBreaker.snapshot('ai-fallback').state, 'CLOSED');
    assert.equal(deps.circuitBreaker.snapshot('payment').failureCount, 0); // untouched service
  });
});
