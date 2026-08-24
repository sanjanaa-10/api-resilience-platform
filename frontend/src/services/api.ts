import type {
  AnomalyHistoryEnvelope,
  AnomaliesEnvelope,
  AnomalyStatusReport,
  EventsEnvelope,
  Incident,
  IncidentsEnvelope,
  MetricsSnapshot,
  ServicesOverview,
} from '../types/api'

/** Centralized API base: override with VITE_API_BASE_URL, default the gateway. */
export const API_BASE_URL: string = (
  import.meta.env.VITE_API_BASE_URL as string | undefined ??
  'http://localhost:4000'
).replace(/\/+$/, '')

export class ApiClientError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
  }
}

async function fetchJson<T>(path: string, timeoutMs = 8_000): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      throw new ApiClientError('Gateway did not respond in time.', 0)
    }
    throw new ApiClientError('Gateway unavailable.', 0)
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (typeof body.error?.message === 'string') message = body.error.message
    } catch {
      /* keep generic message */
    }
    throw new ApiClientError(message, response.status)
  }
  return (await response.json()) as T
}

export const api = {
  services(): Promise<ServicesOverview> {
    return fetchJson('/api/services')
  },
  metrics(): Promise<MetricsSnapshot> {
    return fetchJson('/api/metrics')
  },
  events(query: { service?: string; type?: string; severity?: string; limit?: number }): Promise<EventsEnvelope> {
    const params = new URLSearchParams()
    if (query.service) params.set('service', query.service)
    if (query.type) params.set('type', query.type)
    if (query.severity) params.set('severity', query.severity)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const qs = params.toString()
    return fetchJson(`/api/events${qs ? `?${qs}` : ''}`)
  },
  incidents(): Promise<IncidentsEnvelope> {
    return fetchJson('/api/incidents')
  },
  activeIncidents(): Promise<IncidentsEnvelope> {
    return fetchJson('/api/incidents/active')
  },
  incident(id: string): Promise<Incident> {
    return fetchJson(
      `/api/incidents/${encodeURIComponent(id)}`,
    )
  },
  anomalies(): Promise<AnomaliesEnvelope> {
    return fetchJson('/api/anomalies')
  },
  anomalyReport(service: string): Promise<AnomalyStatusReport> {
    return fetchJson(`/api/anomalies/${encodeURIComponent(service)}`)
  },
  anomalyHistory(service: string): Promise<AnomalyHistoryEnvelope> {
    return fetchJson(`/api/anomalies/${encodeURIComponent(service)}/history`)
  },
}
