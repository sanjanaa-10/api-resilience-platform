import { useMemo } from 'react'
import { useGatewayData } from '../hooks/useGatewayData'
import { usePolling } from '../hooks/usePolling'
import { api } from '../services/api'
import { agoStamp, fmtInt, fmtMs, fmtPct, timeHMS } from '../lib/format'
import { Panel, PanelHeader, SectionTitle } from '../components/ui/Panel'
import { EmptyState, ErrorState, StaleNotice } from '../components/ui/Feedback'
import { ThroughputChart, SuccessRateChart, LatencyChart } from '../components/metrics/charts'

function Counter({
  label,
  value,
  tone = 'ink',
}: {
  label: string
  value: string
  tone?: 'ink' | 'ok' | 'warn' | 'crit'
}) {
  const color =
    tone === 'ok'
      ? 'text-ok'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'crit'
          ? 'text-crit'
          : 'text-ink'
  return (
    <div className="px-5 py-4">
      <dt className="text-[10px] tracking-wide text-faint uppercase">{label}</dt>
      <dd className={`mt-1 font-mono text-xl tabular-nums ${color}`}>{value}</dd>
    </div>
  )
}

export function MetricsPage() {
  const { metrics, history } = useGatewayData()
  const events = usePolling(() => api.events({ limit: 200 }), { intervalMs: 8_000 })

  const totals = metrics.data?.totals ?? null

  // Rate-limit visibility comes from the event stream (metrics counters don't
  // track it) — honestly labeled as a recent-events count.
  const rateLimitedRecent = useMemo(
    () =>
      (events.data?.events ?? []).filter((event) => event.eventType === 'RATE_LIMITED').length,
    [events.data],
  )

  const serviceNames = useMemo(() => Object.keys(metrics.data?.services ?? {}), [metrics.data])

  return (
    <div className="flex flex-col gap-8">
      <header>
        <SectionTitle note={metrics.data !== null ? `updated ${agoStamp(metrics.lastUpdatedAt)}` : undefined}>
          Resilience metrics
        </SectionTitle>
        <p className="max-w-2xl text-sm leading-relaxed text-soft">
          Live counters and session charts built from real gateway traffic. The series below grows
          while this page stays open — nothing is simulated.
        </p>
      </header>

      {metrics.isStale && metrics.data !== null && <StaleNotice onRetry={metrics.refresh} />}

      {metrics.status === 'error' && metrics.data === null ? (
        <Panel>
          <ErrorState message="Gateway unavailable." onRetry={metrics.refresh} />
        </Panel>
      ) : totals === null ? (
        <Panel>
          <EmptyState title="Waiting for the first snapshot…" note="/api/metrics has not answered yet." />
        </Panel>
      ) : (
        <>
          {/* Counters */}
          <Panel>
            <PanelHeader
              title="Cumulative counters"
              hint={`snapshot ${timeHMS(metrics.data?.generatedAt)} UTC`}
            />
            <dl className="grid grid-cols-2 divide-line border-b border-line sm:grid-cols-4 sm:divide-x">
              <Counter label="Requests" value={fmtInt(totals.requestCount)} />
              <Counter label="Succeeded" value={fmtInt(totals.successCount)} tone="ok" />
              <Counter label="Failed" value={fmtInt(totals.failureCount)} tone={totals.failureCount > 0 ? 'crit' : 'ink'} />
              <Counter label="Timeouts" value={fmtInt(totals.timeoutCount)} tone={totals.timeoutCount > 0 ? 'warn' : 'ink'} />
            </dl>
            <dl className="grid grid-cols-2 divide-line border-b border-line sm:grid-cols-4 sm:divide-x">
              <Counter label="Retries" value={fmtInt(totals.retryCount)} tone={totals.retryCount > 0 ? 'warn' : 'ink'} />
              <Counter label="Failovers" value={fmtInt(totals.failoverCount)} tone={totals.failoverCount > 0 ? 'warn' : 'ink'} />
              <Counter label="Circuit opens" value={fmtInt(totals.circuitOpenCount)} tone={totals.circuitOpenCount > 0 ? 'crit' : 'ink'} />
              <Counter
                label="Rate limited (recent events)"
                value={fmtInt(rateLimitedRecent)}
                tone={rateLimitedRecent > 0 ? 'warn' : 'ink'}
              />
            </dl>
            <dl className="grid grid-cols-2 sm:grid-cols-4">
              <Counter label="Avg latency" value={fmtMs(totals.averageLatencyMs)} />
              <Counter label="p95 latency" value={fmtMs(totals.p95LatencyMs)} />
              <Counter
                label="Success rate"
                value={
                  totals.requestCount > 0
                    ? fmtPct(totals.successCount / totals.requestCount)
                    : '—'
                }
                tone="ok"
              />
              <Counter
                label="Failure rate"
                value={
                  totals.requestCount > 0
                    ? fmtPct(totals.failureCount / totals.requestCount)
                    : '—'
                }
                tone={totals.failureCount > 0 ? 'crit' : 'ink'}
              />
            </dl>
          </Panel>

          {/* Charts */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="Throughput" hint="requests per sampling interval · this session" />
              <div className="px-3 py-4">
                {history.length > 1 ? (
                  <ThroughputChart history={history} />
                ) : (
                  <EmptyState
                    title="The pulse starts with traffic."
                    note="Send requests through the gateway — the chart draws itself."
                  />
                )}
              </div>
            </Panel>

            <Panel>
              <PanelHeader title="Success rate" hint="% per interval · interval deltas" />
              <div className="px-3 py-4">
                {history.length > 1 ? (
                  <SuccessRateChart history={history} />
                ) : (
                  <EmptyState title="No intervals measured yet." />
                )}
              </div>
            </Panel>
          </div>

          <Panel>
            <PanelHeader title="p95 latency per provider" hint="milliseconds · session series" />
            <div className="px-3 py-4">
              {history.length > 1 && serviceNames.length > 0 ? (
                <LatencyChart history={history} services={serviceNames} />
              ) : (
                <EmptyState title="Waiting for latency samples." />
              )}
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
