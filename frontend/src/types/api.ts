/**
 * TypeScript contracts mirroring the backend's actual response structures
 * (backend/src/types/index.ts, observability/*, anomaly/*).
 * No `any` — these are the single source of truth for every fetch.
 */

export type ProbeStatus = 'healthy' | 'unhealthy' | 'unknown'
export type CircuitStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN'
export type EventSeverity = 'INFO' | 'WARNING' | 'CRITICAL'
export type EventType =
  | 'REQUEST_STARTED'
  | 'REQUEST_COMPLETED'
  | 'REQUEST_FAILED'
  | 'RETRY_ATTEMPT'
  | 'RATE_LIMITED'
  | 'CIRCUIT_OPENED'
  | 'CIRCUIT_HALF_OPEN'
  | 'CIRCUIT_CLOSED'
  | 'FAILOVER_STARTED'
  | 'FAILOVER_COMPLETED'
  | 'UPSTREAM_TIMEOUT'
  | 'HEALTH_CHANGED'
  | 'ANOMALY_DETECTED'
  | 'ANOMALY_RESOLVED'

export const EVENT_TYPES: readonly EventType[] = [
  'REQUEST_STARTED',
  'REQUEST_COMPLETED',
  'REQUEST_FAILED',
  'RETRY_ATTEMPT',
  'RATE_LIMITED',
  'CIRCUIT_OPENED',
  'CIRCUIT_HALF_OPEN',
  'CIRCUIT_CLOSED',
  'FAILOVER_STARTED',
  'FAILOVER_COMPLETED',
  'UPSTREAM_TIMEOUT',
  'HEALTH_CHANGED',
  'ANOMALY_DETECTED',
  'ANOMALY_RESOLVED',
]

export const EVENT_SEVERITIES: readonly EventSeverity[] = ['INFO', 'WARNING', 'CRITICAL']

// ─── Services ────────────────────────────────────────────────────────────────

export interface CircuitSnapshot {
  state: CircuitStateName
  failureCount: number
  openedAt: string | null
}

export interface ServiceStatusWithCircuit {
  name: string
  displayName: string
  baseUrl: string
  status: ProbeStatus
  latencyMs: number | null
  lastCheckedAt: string | null
  consecutiveFailures: number
  lastError: string | null
  circuit: CircuitSnapshot
}

export interface ServicesOverview {
  summary: { total: number; healthy: number; unhealthy: number; unknown: number }
  services: ServiceStatusWithCircuit[]
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface ServiceMetrics {
  requestCount: number
  successCount: number
  failureCount: number
  averageLatencyMs: number | null
  p95LatencyMs: number | null
  timeoutCount: number
  retryCount: number
  failoverCount: number
}

export interface MetricsSnapshot {
  generatedAt: string
  totals: ServiceMetrics & { circuitOpenCount: number }
  services: Record<string, ServiceMetrics>
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface ResilienceEvent {
  eventId: string
  timestamp: string
  eventType: EventType
  service: string
  severity: EventSeverity
  requestId: string | null
  message: string
  metadata: Record<string, unknown>
}

export interface EventsEnvelope {
  count: number
  events: ResilienceEvent[]
}

// ─── Incidents ───────────────────────────────────────────────────────────────

export type IncidentStatus = 'ACTIVE' | 'RESOLVED'

export interface IncidentTimelineEntry {
  timestamp: string
  eventType: EventType
  severity: EventSeverity
  requestId: string | null
  message: string
}

export interface Incident {
  incidentId: string
  service: string
  startedAt: string
  endedAt: string | null
  status: IncidentStatus
  severity: EventSeverity
  title: string
  summary: string
  eventCount: number
  failoverOccurred: boolean
  circuitOpened: boolean
  affectedRequests: number
  timeline: IncidentTimelineEntry[]
}

export interface IncidentsEnvelope {
  count: number
  incidents: Incident[]
}

// ─── Anomalies ───────────────────────────────────────────────────────────────

export type AnomalyStatus = 'NORMAL' | 'WARNING' | 'ANOMALOUS' | 'INSUFFICIENT_DATA'

export type MetricKey =
  | 'avgLatencyMs'
  | 'p95LatencyMs'
  | 'errorRate'
  | 'timeoutRate'
  | 'retryRate'
  | 'failoverRate'

export interface MetricBaselineView {
  median: number
  mad: number
  sampleCount: number
}

export interface AnomalyReason {
  metric: MetricKey
  current: number
  baseline: number
  changePercent: number
  zScore: number
}

export interface FeatureSnapshot {
  service: string
  timestamp: string
  requestVolume: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  errorRate: number
  timeoutRate: number
  retryRate: number
  failoverRate: number
}

export interface AnomalyStatusReport {
  service: string
  timestamp: string
  status: AnomalyStatus
  /** 0..1, null while INSUFFICIENT_DATA. */
  score: number | null
  sampleCount: number
  windowSize: number
  featureSnapshot: FeatureSnapshot
  baseline: Partial<Record<MetricKey, MetricBaselineView>>
  reasons: AnomalyReason[]
}

export interface AnomaliesEnvelope {
  count: number
  anomalies: AnomalyStatusReport[]
}

export interface AssessmentRecord {
  timestamp: string
  status: AnomalyStatus
  score: number | null
  topMetric: MetricKey | null
}

export interface AnomalyHistoryEnvelope {
  service: string
  count: number
  history: AssessmentRecord[]
}
