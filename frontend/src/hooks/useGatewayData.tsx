import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../services/api'
import { usePolling, type PollingState } from './usePolling'
import type { MetricsSnapshot, ServicesOverview } from '../types/api'

export interface MetricPoint {
  t: number
  /** Requests observed in this interval (delta of cumulative counters). */
  requests: number
  /** Success fraction over the interval; null until two samples exist. */
  successRate: number | null
  retries: number
  timeouts: number
  failovers: number
  /** Per-service latency statistics captured at this sample. */
  latencies: Record<string, { avg: number | null; p95: number | null }>
}

interface GatewayDataValue {
  metrics: PollingState<MetricsSnapshot>
  services: PollingState<ServicesOverview>
  /** Client-side rolling series built from consecutive metric snapshots. */
  history: MetricPoint[]
  /** True while at least one recent fetch has succeeded. */
  connected: boolean
}

const METRICS_INTERVAL_MS = 2_500
const SERVICES_INTERVAL_MS = 4_000
const HISTORY_CAP = 90

const GatewayDataContext = createContext<GatewayDataValue | null>(null)

function delta(current: number, previous: number): number {
  return Math.max(0, current - previous)
}

/**
 * One shared poller for the two hottest endpoints (metrics + services) so the
 * shell status indicator, overview, topology and pages all read a single
 * source — no per-component interval storms. The throughput/latency history
 * series is derived client-side by diffing consecutive snapshots (real data,
 * session-scoped, bounded length).
 */
export function GatewayDataProvider({ children }: { children: ReactNode }) {
  const metrics = usePolling(() => api.metrics(), { intervalMs: METRICS_INTERVAL_MS })
  const services = usePolling(() => api.services(), { intervalMs: SERVICES_INTERVAL_MS })

  const previousTotals = useRef<MetricsSnapshot['totals'] | null>(null)
  const [history, setHistory] = useState<MetricPoint[]>([])

  useEffect(() => {
    const snapshot = metrics.data
    if (snapshot === null) return
    const totals = snapshot.totals
    const prev = previousTotals.current

    // A gateway restart resets lifetime counters; re-baseline silently so the
    // session series keeps flowing instead of blocking on the old high-water.
    if (prev !== null && totals.requestCount < prev.requestCount) {
      previousTotals.current = totals
      return
    }

    if (
      prev !== null &&
      totals.requestCount >= prev.requestCount &&
      (totals.requestCount > prev.requestCount || totals.retryCount !== prev.retryCount)
    ) {
      const requests = delta(totals.requestCount, prev.requestCount)
      const latencies: MetricPoint['latencies'] = {}
      for (const [service, state] of Object.entries(snapshot.services)) {
        latencies[service] = { avg: state.averageLatencyMs, p95: state.p95LatencyMs }
      }
      const point: MetricPoint = {
        t: Date.now(),
        requests,
        successRate:
          requests > 0 ? Math.min(1, delta(totals.successCount, prev.successCount) / requests) : null,
        retries: delta(totals.retryCount, prev.retryCount),
        timeouts: delta(totals.timeoutCount, prev.timeoutCount),
        failovers: delta(totals.failoverCount, prev.failoverCount),
        latencies,
      }
      setHistory((existing) => {
        const next = [...existing, point]
        return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next
      })
    }
    previousTotals.current = totals
  }, [metrics.data])

  const connected =
    !(metrics.status === 'error' && metrics.data === null) &&
    !(services.status === 'error' && services.data === null)

  return (
    <GatewayDataContext.Provider value={{ metrics, services, history, connected }}>
      {children}
    </GatewayDataContext.Provider>
  )
}

export function useGatewayData(): GatewayDataValue {
  const value = useContext(GatewayDataContext)
  if (value === null) throw new Error('useGatewayData must be used inside GatewayDataProvider.')
  return value
}
