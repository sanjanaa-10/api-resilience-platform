export type NodeEnv = 'development' | 'test' | 'production';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Env {
  nodeEnv: NodeEnv;
  port: number;
  serviceName: string;
  logLevel: LogLevel;
  /** Health probe interval for the gateway monitor (ms). */
  healthCheckIntervalMs: number;
  /** Hard deadline for any single upstream call (ms). */
  upstreamTimeoutMs: number;
  /** Retry policy — maxAttempts INCLUDES the initial request. */
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  /** Wall-clock ceiling for one full proxy call incl. all retries (ms). */
  retryTotalBudgetMs: number;
  paymentBaseUrl?: string;
  aiBaseUrl?: string;
  aiFallbackBaseUrl?: string;
  notificationBaseUrl?: string;
  /** Max tokens per client bucket. */
  rateLimitCapacity: number;
  /** Tokens added per second. */
  rateLimitRefillRate: number;
  /** Inactive bucket cleanup interval (ms). */
  rateLimitCleanupIntervalMs: number;
  /** Consecutive failed logical requests that trip a circuit (per service). */
  circuitFailureThreshold: number;
  /** Cool-off before an OPEN circuit admits probes (ms). */
  circuitOpenDurationMs: number;
  /** Concurrent probe requests allowed while HALF_OPEN. */
  circuitHalfOpenMaxRequests: number;
  /** Max resilience events retained in memory (newest kept). */
  eventsCapacity: number;
  /** Latency samples kept per service for avg/p95 computation. */
  metricsLatencyWindow: number;
  /** Warning-signal count within the lookback window that opens an incident. */
  incidentFailureThreshold: number;
  /** Rolling window for counting warning signals (ms). */
  incidentLookbackMs: number;
  /** Failure-free period required before an incident resolves (ms). */
  incidentRecoveryQuietMs: number;
  /** Resolved incidents retained in memory. */
  incidentMaxResolved: number;
  /** Anomaly detector: baseline window size per service+metric. */
  anomalyWindowSize: number;
  /** Anomaly detector: samples required before scoring (cold start). */
  anomalyMinSamples: number;
  /** How often metrics are sampled into feature snapshots (ms). */
  anomalySampleIntervalMs: number;
  /** Score at or above which status becomes WARNING (0..1). */
  anomalyScoreWarning: number;
  /** Score at or above which status becomes ANOMALOUS (0..1). */
  anomalyScoreAnomalous: number;
}

/** Exact payload contract for GET /health. */
export interface HealthCheckResult {
  status: 'ok';
  service: string;
}

/** Metadata returned from GET /. */
export interface ServiceMetaResult {
  service: string;
  version: string;
  description: string;
  endpoints: {
    health: string;
    services: string;
    serviceCheck: string;
    [proxy: string]: string;
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
    stack?: string;
  };
}

// ─── Gateway domain ──────────────────────────────────────────────────────────

/**
 * Upstream provider identities. ai-primary and ai-fallback form a failover
 * group behind ONE public route; payment and notification are singleton
 * groups. Every provider gets independent health + circuit state.
 */
export type ServiceName = 'payment' | 'notification' | 'ai-primary' | 'ai-fallback';

/** Static, centralized registration of one upstream service. */
export interface ServiceRegistration {
  name: ServiceName;
  displayName: string;
  baseUrl: string;
  healthPath: string;
  /** Path exposed by the gateway, e.g. "/api/payment". */
  gatewayPath: string;
  /** Realistic endpoint on the upstream service, e.g. "/api/payments/test". */
  targetPath: string;
}

/**
 * A failover group: an ordered list of equivalent providers behind one public
 * route. providers[0] is the primary; the rest are tried in order, subject to
 * the failover budget and eligibility gates.
 */
export interface ProviderGroup {
  id: string;
  displayName: string;
  /** Public route prefix exposed by the gateway, e.g. "/api/ai". */
  gatewayPath: string;
  /** Realistic endpoint appended on the chosen provider, e.g. "/api/ai/test". */
  targetPath: string;
  providers: ServiceRegistration[];
}

export type ProbeStatus = 'healthy' | 'unhealthy' | 'unknown';

/** Runtime health snapshot maintained by the health monitor. */
export interface ServiceHealthState {
  name: ServiceName;
  displayName: string;
  baseUrl: string;
  status: ProbeStatus;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface ServicesOverview {
  summary: { total: number; healthy: number; unhealthy: number; unknown: number };
  services: ServiceHealthState[];
}

export type GatewayErrorCode =
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_INVALID_RESPONSE'
  | 'CIRCUIT_OPEN';

/** Normalized error envelope the gateway returns when an upstream call fails. */
export interface GatewayErrorBody {
  success: false;
  error: {
    code: GatewayErrorCode;
    message: string;
    statusCode: number;
    requestId?: string;
    service: ServiceName;
    upstream?: Record<string, unknown>;
  };
}

// ─── Retry domain ────────────────────────────────────────────────────────────

/**
 * Retry policy. maxAttempts INCLUDES the initial request:
 * 3 attempts = 1 initial + 2 retries.
 */
export interface RetryPolicyConfig {
  maxAttempts: number;
  /** Delay before the first retry; doubles per failed attempt. */
  baseDelayMs: number;
  /** Upper bound for any single computed backoff delay (before jitter). */
  maxDelayMs: number;
}

/** One executed attempt inside a retry loop — the unit of observability. */
export interface RetryAttemptRecord {
  attempt: number;
  /** Machine-readable outcome label, e.g. 'SUCCESS' | 'TIMEOUT' | 'HTTP_503'. */
  outcome: string;
  /** Upstream HTTP status when one was received, otherwise null. */
  status: number | null;
  /** Whether another attempt was scheduled after this one. */
  retried: boolean;
  /** Present only when retried=true. */
  retryReason?: string;
  /** Backoff+jitter wait applied before the next attempt (ms). */
  delayMs?: number;
}

// ─── Proxy domain ────────────────────────────────────────────────────────────

export type ProxyOutcome =
  | {
      kind: 'success';
      status: number;
      body: unknown;
      durationMs: number;
      upstreamRequestId: string | null;
    }
  | {
      kind: 'upstream-error';
      status: number;
      body: unknown;
      durationMs: number;
      upstreamRequestId: string | null;
    }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'unreachable'; durationMs: number; errorMessage: string }
  | { kind: 'invalid-response'; status: number; durationMs: number; bodySnippet: string };

/** Observability + response metadata produced by the retry loop. */
export interface ProxyRetryStats {
  attempts: number;
  retries: number;
  totalDurationMs: number;
  attemptsLog: RetryAttemptRecord[];
}

/** Result of proxying one logical request at ONE provider (incl. its retries). */
export interface ProxyBusinessResult {
  outcome: ProxyOutcome;
  retry: ProxyRetryStats;
}

// ─── Circuit breaker domain ──────────────────────────────────────────────────

export type CircuitStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Public circuit view exposed alongside health data. */
export interface CircuitSnapshot {
  state: CircuitStateName;
  /** Consecutive failed logical requests (reset on success). */
  failureCount: number;
  /** ISO timestamp of the last CLOSED→OPEN transition; null while closed. */
  openedAt: string | null;
}

/** GET /api/services item: monitor snapshot + breaker snapshot merged. */
export interface ServiceStatusWithCircuit extends ServiceHealthState {
  circuit: CircuitSnapshot;
}

export interface ServicesOverviewWithCircuit {
  summary: { total: number; healthy: number; unhealthy: number; unknown: number };
  services: ServiceStatusWithCircuit[];
}

// ─── Failover domain ─────────────────────────────────────────────────────────

/** Why a request moved off its primary provider. */
export type FailoverReason =
  | 'UPSTREAM_TIMEOUT'
  | 'NETWORK_UNAVAILABLE'
  | 'HTTP_502'
  | 'HTTP_503'
  | 'HTTP_504'
  | 'CIRCUIT_OPEN';

/** Failover metadata merged into every group response. */
export interface FailoverMetadata {
  /** True when the response was served by a non-primary provider. */
  occurred: boolean;
  /** Provider that actually served this response; null when none did. */
  selectedProvider: ServiceName | null;
  /** Only present when a failover happened. */
  primary?: ServiceName;
  reason?: FailoverReason;
}

/** Per-provider execution trace inside one logical request. */
export interface FailoverAttemptRecord {
  provider: ServiceName;
  attempted: boolean;
  /** Why this provider was skipped (present only when attempted=false). */
  skipReason?: 'BUDGET_EXHAUSTED' | 'UNHEALTHY' | 'CIRCUIT_OPEN';
  outcomeKind?: string;
}

/** Full result of executeWithFailover for observability and controller mapping. */
export interface FailoverExecution {
  /** The group's primary provider, always attempts[0]'s target. */
  primaryProvider: ServiceName;
  /** Final outcome from the provider that served the request; null when nothing could be attempted. */
  outcome: ProxyOutcome | null;
  retry: ProxyRetryStats | null;
  selectedProvider: ServiceName | null;
  failoverOccurred: boolean;
  failoverReason: FailoverReason | null;
  attempts: FailoverAttemptRecord[];
  primaryDurationMs: number | null;
  fallbackDurationMs: number | null;
  totalDurationMs: number;
}
