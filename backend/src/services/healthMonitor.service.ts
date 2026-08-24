import type { ServiceRegistration, ServiceHealthState, ServicesOverview } from '../types';
import { callUpstream, tryParseJson } from './upstreamClient.service';
import { logger } from '../utils/logger';

export interface HealthMonitorOptions {
  /** Polling interval in milliseconds. */
  intervalMs: number;
  /** Per-probe deadline in milliseconds. */
  timeoutMs: number;
  /**
   * Observability hook, fired whenever a probe produces a status CHANGE
   * (including the first unknown -> healthy/unhealthy determination).
   * Hook failures are swallowed: monitoring must never break probing.
   */
  onStateChange?: (next: ServiceHealthState, previous: ServiceHealthState | null) => void;
}

/**
 * Periodically probes every registered upstream and maintains an in-memory
 * health snapshot per service.
 *
 * Design points:
 *  - A probe is "healthy" only when the upstream answers HTTP 200 AND its
 *    body reports status "healthy" (simulators report unhealthy-in-body).
 *  - Rounds never overlap: if a round outlives the interval (e.g. many slow
 *    upstreams), the next tick is skipped instead of piling up.
 *  - Logs state TRANSITIONS at info level; steady-state results stay at
 *    debug so production log volume stays flat.
 *  - `consecutiveFailures` is the seed metric for the future circuit breaker.
 */
export class HealthMonitor {
  private readonly states = new Map<string, ServiceHealthState>();
  private timer: NodeJS.Timeout | null = null;
  private roundInFlight = false;

  constructor(
    private readonly registrations: readonly ServiceRegistration[],
    private readonly options: HealthMonitorOptions,
  ) {
    for (const entry of registrations) {
      this.states.set(entry.name, {
        name: entry.name,
        displayName: entry.displayName,
        baseUrl: entry.baseUrl,
        status: 'unknown',
        latencyMs: null,
        lastCheckedAt: null,
        consecutiveFailures: 0,
        lastError: null,
      });
    }
  }

  start(): void {
    if (this.timer !== null) return;
    void this.runRound();
    this.timer = setInterval(() => void this.runRound(), this.options.intervalMs);
    this.timer.unref();
    logger.info('health_monitor_started', {
      services: this.registrations.length,
      intervalMs: this.options.intervalMs,
      timeoutMs: this.options.timeoutMs,
    });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('health_monitor_stopped');
  }

  /** One full probing round. Safe to call manually via POST /api/services/check. */
  async runRound(): Promise<void> {
    if (this.roundInFlight) return;
    this.roundInFlight = true;
    try {
      await Promise.all(this.registrations.map((entry) => this.probeOne(entry)));
    } finally {
      this.roundInFlight = false;
    }
  }

  getAllStates(): ServiceHealthState[] {
    return this.registrations.map(
      (entry) => ({ ...(this.states.get(entry.name) as ServiceHealthState) }),
    );
  }

  getOverview(): ServicesOverview {
    const services = this.getAllStates();
    const count = (status: string): number =>
      services.filter((state) => state.status === status).length;
    return {
      summary: {
        total: services.length,
        healthy: count('healthy'),
        unhealthy: count('unhealthy'),
        unknown: count('unknown'),
      },
      services,
    };
  }

  /**
   * Strict eligibility check used by the failover decision.
   * Only a CONFIRMED 'healthy' snapshot passes; 'unknown' (never probed yet,
   * e.g. at boot) and 'unhealthy' both block fallback selection. The boot
   * window is bounded by the first probing round, which start() runs
   * immediately.
   */
  isHealthy(name: string): boolean {
    const state = this.states.get(name);
    return state?.status === 'healthy';
  }

  private async probeOne(entry: ServiceRegistration): Promise<void> {
    const previous = this.states.get(entry.name);
    const url = `${entry.baseUrl}${entry.healthPath}`;
    const result = await callUpstream(url, {
      headers: { accept: 'application/json' },
      timeoutMs: this.options.timeoutMs,
    });

    let healthy: boolean;
    let lastError: string | null;

    switch (result.kind) {
      case 'timeout':
        healthy = false;
        lastError = `health check timed out after ${this.options.timeoutMs}ms`;
        break;
      case 'network-error':
        healthy = false;
        lastError = result.errorMessage;
        break;
      case 'response': {
        const parsed = tryParseJson(result.bodyText);
        const reportedStatus =
          parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
            ? (parsed.value as { status?: unknown }).status
            : undefined;
        healthy = result.status === 200 && reportedStatus === 'healthy';
        lastError = healthy
          ? null
          : result.status !== 200
            ? `upstream answered HTTP ${result.status}`
            : `upstream reported status "${String(reportedStatus)}"`;
        break;
      }
    }

    const nextStatus = healthy ? ('healthy' as const) : ('unhealthy' as const);
    const updated: ServiceHealthState = {
      name: entry.name,
      displayName: entry.displayName,
      baseUrl: entry.baseUrl,
      status: nextStatus,
      latencyMs: result.durationMs,
      lastCheckedAt: new Date().toISOString(),
      consecutiveFailures: healthy ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
      lastError,
    };

    this.states.set(entry.name, updated);

    // Observability hook: fire on ANY status change, including the first
    // determination out of 'unknown'. Failures are contained here.
    if (
      this.options.onStateChange !== undefined &&
      previous !== undefined &&
      previous.status !== nextStatus
    ) {
      try {
        this.options.onStateChange(updated, previous);
      } catch (error) {
        logger.warn('health_observer_error', { errorMessage: (error as Error).message });
      }
    }

    if (previous && previous.status !== 'unknown' && previous.status !== nextStatus) {
      logger.info('service_status_changed', {
        service: entry.name,
        from: previous.status,
        to: nextStatus,
        latencyMs: updated.latencyMs,
        error: updated.lastError,
      });
    } else if (!healthy) {      logger.debug('health_check_failed', {
        service: entry.name,
        consecutiveFailures: updated.consecutiveFailures,
        error: updated.lastError,
      });
    } else {
      logger.debug('health_check_ok', { service: entry.name, latencyMs: updated.latencyMs });
    }
  }
}
