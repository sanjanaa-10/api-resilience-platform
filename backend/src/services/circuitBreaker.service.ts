import type { CircuitSnapshot, CircuitStateName, ServiceName } from '../types';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Per-service runtime state. Guarded invariant: every read-modify-write of
 * this structure happens synchronously inside canRequest()/recordSuccess()/
 * recordFailure() — never across an await — so on Node's single-threaded
 * event loop each operation is effectively atomic.
 */
interface CircuitRuntime {
  state: CircuitStateName;
  /** Consecutive failed LOGICAL requests (final outcomes, not retry attempts). */
  failureCount: number;
  /** Date.now() when the circuit last transitioned to OPEN; null while closed. */
  openedAtMs: number | null;
  /** Currently admitted HALF_OPEN probes (max = halfOpenMaxRequests). */
  activeProbes: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive failed requests (final outcomes) that trip the circuit. */
  failureThreshold: number;
  /** How long an OPEN circuit rejects before admitting probes (ms). */
  openDurationMs: number;
  /** Concurrent probe requests allowed while HALF_OPEN. */
  halfOpenMaxRequests: number;
}

export interface AdmissionDecision {
  allowed: boolean;
  /** State the decision was made in (after any lazy transition). */
  state: CircuitStateName;
  /** True when this specific request IS the admitted recovery probe. */
  isProbe: boolean;
}

function createRuntime(): CircuitRuntime {
  return { state: 'CLOSED', failureCount: 0, openedAtMs: null, activeProbes: 0 };
}

/**
 * Per-service circuit breaker — admission control based on recent REQUEST
 * outcomes. Deliberately independent of the health monitor: the monitor
 * answers "is the service up?" via background probes for observability,
 * while the breaker answers "should THIS request through?" from live traffic
 * results. They may legitimately disagree for a while.
 *
 * Timing is lazy: no timers are created per circuit. OPEN→HALF_OPEN is
 * evaluated whenever a request arrives after openDurationMs has elapsed —
 * the same elapsed-time pattern as token-bucket refill.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<ServiceName, CircuitRuntime>();

  constructor(
    private readonly options: CircuitBreakerOptions,
    /** Injectable clock for deterministic tests (defaults to wall clock). */
    private readonly now: () => number = Date.now,
  ) {}

  // ─── Admission ──────────────────────────────────────────────────────────────

  /**
   * Synchronous check-and-reserve. Callers MUST eventually pair an allowed
   * request with exactly one recordSuccess()/recordFailure() so admitted
   * probe slots are released and outcomes are counted.
   */
  canRequest(service: ServiceName, requestId?: string): AdmissionDecision {
    const circuit = this.getOrCreate(service);

    // Lazy OPEN -> HALF_OPEN once the cool-off has elapsed.
    if (
      circuit.state === 'OPEN' &&
      circuit.openedAtMs !== null &&
      this.now() - circuit.openedAtMs >= this.options.openDurationMs
    ) {
      this.transition(circuit, service, 'HALF_OPEN', 'open_duration_elapsed', requestId);
    }

    if (circuit.state === 'OPEN') {
      return { allowed: false, state: 'OPEN', isProbe: false };
    }

    if (circuit.state === 'HALF_OPEN') {
      if (circuit.activeProbes >= this.options.halfOpenMaxRequests) {
        return { allowed: false, state: 'HALF_OPEN', isProbe: false };
      }
      // Reserve the probe slot NOW, synchronously — this is what prevents
      // concurrent requests from racing into multiple simultaneous probes.
      circuit.activeProbes += 1;
      return { allowed: true, state: 'HALF_OPEN', isProbe: true };
    }

    return { allowed: true, state: 'CLOSED', isProbe: false };
  }

  // ─── Outcome recording (once per LOGICAL request, never per retry attempt) ──

  recordSuccess(service: ServiceName, requestId?: string): void {
    const circuit = this.getOrCreate(service);
    if (circuit.state === 'HALF_OPEN') {
      circuit.activeProbes = Math.max(0, circuit.activeProbes - 1);
      this.transition(circuit, service, 'CLOSED', 'probe_success', requestId);
    }
    circuit.failureCount = 0;
  }

  recordFailure(service: ServiceName, requestId?: string, reason?: string): void {
    const circuit = this.getOrCreate(service);

    if (circuit.state === 'HALF_OPEN') {
      circuit.activeProbes = Math.max(0, circuit.activeProbes - 1);
      circuit.failureCount += 1;
      this.transition(circuit, service, 'OPEN', reason ?? 'probe_failed', requestId);
      return;
    }

    // Failures recorded while already OPEN (stragglers from before the trip)
    // must not inflate anything or extend the cool-off — ignore them.
    if (circuit.state !== 'CLOSED') return;

    circuit.failureCount += 1;
    if (circuit.failureCount >= this.options.failureThreshold) {
      this.transition(circuit, service, 'OPEN', reason ?? 'failure_threshold_reached', requestId);
    }
  }

  // ─── Introspection ─────────────────────────────────────────────────────────

  snapshot(service: ServiceName): CircuitSnapshot {
    const circuit = this.getOrCreate(service);
    return {
      state: circuit.state,
      failureCount: circuit.failureCount,
      openedAt: circuit.openedAtMs !== null ? new Date(circuit.openedAtMs).toISOString() : null,
    };
  }

  snapshotAll(): Record<ServiceName, CircuitSnapshot> {
    const result = {} as Record<ServiceName, CircuitSnapshot>;
    for (const service of this.circuits.keys()) {
      result[service] = this.snapshot(service);
    }
    return result;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private getOrCreate(service: ServiceName): CircuitRuntime {
    let circuit = this.circuits.get(service);
    if (circuit === undefined) {
      circuit = createRuntime();
      this.circuits.set(service, circuit);
    }
    return circuit;
  }

  private transition(
    circuit: CircuitRuntime,
    service: ServiceName,
    newState: CircuitStateName,
    reason: string,
    requestId?: string,
  ): void {
    const previousState = circuit.state;
    if (previousState === newState && newState !== 'CLOSED') return;

    circuit.state = newState;
    if (newState === 'OPEN') {
      circuit.openedAtMs = this.now();
      circuit.activeProbes = 0;
    }
    if (newState === 'CLOSED') {
      circuit.openedAtMs = null;
      circuit.activeProbes = 0;
      circuit.failureCount = 0;
    }

    logger.info('circuit_state_change', {
      service,
      previousState,
      newState,
      failureCount: circuit.failureCount,
      reason,
      ...(requestId !== undefined ? { requestId } : {}),
      timestamp: new Date().toISOString(),
    });
  }
}

/** Pure classifier: which FINAL proxy outcomes count as circuit failures. */
export function countsAsCircuitFailure(outcome: { kind: string; status?: number }): boolean {
  switch (outcome.kind) {
    case 'timeout':
      return true; // upstream overloaded or hanging
    case 'unreachable':
      return true; // network-level unavailability
    case 'upstream-error':
      // Only the transient gateway statuses signal an availability problem.
      // 500 & friends are deterministic bugs; replaying traffic into a broken
      // deployment would open circuits without protecting anyone.
      return outcome.status === 502 || outcome.status === 503 || outcome.status === 504;
    default:
      // success, invalid-response (contract issue), everything else: no count
      return false;
  }
}

/**
 * Factory used by the composition root — reads the validated env config:
 *   CIRCUIT_BREAKER_FAILURE_THRESHOLD      default 5     consecutive failed requests
 *   CIRCUIT_BREAKER_OPEN_DURATION_MS       default 10000 cool-off before probing
 *   CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS default 1     concurrent recovery probes
 */
export function createCircuitBreakerFromEnv(): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: env.circuitFailureThreshold,
    openDurationMs: env.circuitOpenDurationMs,
    halfOpenMaxRequests: env.circuitHalfOpenMaxRequests,
  });
}
