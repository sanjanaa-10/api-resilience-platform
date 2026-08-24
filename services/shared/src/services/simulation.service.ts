import { delay } from '../utils/delay';
import type {
  ServiceDefinition,
  SimulationConfig,
  SimulationConfigPatch,
  SimulationEngineLike,
  SimulationOutcome,
  SimulationStateSnapshot,
} from '../types';

/**
 * In-memory chaos engine. One instance per process; Node's single-threaded
 * event loop makes plain field mutation safe without locks.
 *
 * Concurrency semantics: each request snapshots the config when it arrives,
 * so changing knobs mid-flight only affects subsequent requests — never ones
 * already sleeping through an artificial latency window.
 */
export class SimulationEngine implements SimulationEngineLike {
  private config: SimulationConfig;
  private requestsHandled = 0;
  private simulatedFailures = 0;
  private readonly startedAtMs = Date.now();

  constructor(private readonly definition: ServiceDefinition) {
    this.config = {
      online: true,
      latencyMs: definition.defaultLatencyMs,
      failureRate: 0,
    };
  }

  getConfig(): Readonly<SimulationConfig> {
    return { ...this.config };
  }

  getState(): SimulationStateSnapshot {
    return {
      service: this.definition.name,
      config: this.getConfig(),
      stats: {
        startedAt: new Date(this.startedAtMs).toISOString(),
        uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
        requestsHandled: this.requestsHandled,
        simulatedFailures: this.simulatedFailures,
      },
    };
  }

  /** Merges a validated patch onto the current configuration. */
  applyPatch(patch: SimulationConfigPatch): SimulationStateSnapshot {
    this.config = { ...this.config, ...patch };
    return this.getState();
  }

  /** Restores default config and zeroes request counters. Keeps process uptime. */
  reset(): SimulationStateSnapshot {
    this.config = {
      online: true,
      latencyMs: this.definition.defaultLatencyMs,
      failureRate: 0,
    };
    this.requestsHandled = 0;
    this.simulatedFailures = 0;
    return this.getState();
  }

  /**
   * Simulates one upstream call:
   * offline -> immediate failure | sleep(latency) -> dice roll -> success/error.
   */
  async performRequest(): Promise<SimulationOutcome> {
    this.requestsHandled += 1;

    const snapshot = this.getConfig();
    if (!snapshot.online) {
      return { kind: 'offline', latencyMs: 0 };
    }

    if (snapshot.latencyMs > 0) {
      await delay(snapshot.latencyMs);
    }

    if (snapshot.failureRate > 0 && Math.random() * 100 < snapshot.failureRate) {
      this.simulatedFailures += 1;
      return { kind: 'error', latencyMs: snapshot.latencyMs };
    }

    return { kind: 'success', latencyMs: snapshot.latencyMs };
  }
}
