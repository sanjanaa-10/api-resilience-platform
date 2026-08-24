export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Controlled chaos knobs — the entire personality of a simulated service. */
export interface SimulationConfig {
  online: boolean;
  latencyMs: number;
  /** Percentage 0-100 of requests that fail with a controlled error. */
  failureRate: number;
  /**
   * HTTP status returned for simulated (non-offline) failures.
   * Optional with engine default 500; settable to e.g. 503 to model
   * TRANSIENT outages for retry/resilience testing.
   */
  failureStatus?: number;
}

export type SimulationConfigPatch = Partial<SimulationConfig>;

export interface SimulationStats {
  startedAt: string;
  uptimeSeconds: number;
  requestsHandled: number;
  simulatedFailures: number;
}

export interface SimulationStateSnapshot {
  service: string;
  config: SimulationConfig;
  stats: SimulationStats;
}

export interface HealthResult {
  service: string;
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  timestamp: string;
}

/** Static identity + behavior contract every simulated service provides. */
export interface ServiceDefinition<TData = unknown> {
  name: string;
  port: number;
  /** Realistic business endpoint, e.g. "/api/payments/test". */
  testEndpointPath: string;
  /** Latency applied when no override has been configured. */
  defaultLatencyMs: number;
  buildPayload: (context: PayloadContext) => TData;
}

export interface PayloadContext {
  requestId: string;
}

export interface SimulationContext<TData = unknown> {
  definition: ServiceDefinition<TData>;
  engine: SimulationEngineLike;
}

/**
 * Narrowed engine surface available to controllers — keeps controllers
 * decoupled from the engine implementation.
 */
export interface SimulationEngineLike {
  getConfig(): Readonly<SimulationConfig>;
  getState(): SimulationStateSnapshot;
  applyPatch(patch: SimulationConfigPatch): SimulationStateSnapshot;
  reset(): SimulationStateSnapshot;
  performRequest(): Promise<SimulationOutcome>;
}

export type SimulationOutcome =
  | { kind: 'success'; latencyMs: number }
  | { kind: 'error'; latencyMs: number }
  | { kind: 'offline'; latencyMs: 0 };

/** Success envelope for business endpoints. */
export interface SimulatedSuccessBody<TData> {
  service: string;
  requestId: string;
  timestamp: string;
  simulatedLatencyMs: number;
  status: 'success';
  data: TData;
}

/** Error/offline envelope for business endpoints. */
export interface SimulatedFailureBody {
  service: string;
  requestId: string;
  timestamp: string;
  simulatedLatencyMs: number;
  status: 'error' | 'offline';
  error: {
    code: 'SIMULATED_FAILURE' | 'SIMULATED_OFFLINE';
    message: string;
  };
}

/** Uniform error envelope produced by the centralized error handler. */
export interface ApiErrorBody {
  success: false;
  error: {
    message: string;
    statusCode: number;
    requestId?: string;
    details?: unknown;
  };
}
