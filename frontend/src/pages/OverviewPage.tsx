import { Link } from 'react-router-dom'
import { ArrowRight, Siren } from 'lucide-react'
import { useGatewayData } from '../hooks/useGatewayData'
import { usePolling } from '../hooks/usePolling'
import { api } from '../services/api'
import { cx, fmtInt, fmtMs, fmtPct } from '../lib/format'
import { Panel, PanelHeader, SectionTitle, Skeleton } from '../components/ui/Panel'
import { EmptyState, ErrorState, LoadingBlock, StaleNotice } from '../components/ui/Feedback'
import { Badge, StatusDot, anomalyTone, circuitTone, healthTone, ANOMALY_LABEL } from '../components/ui/status'
import { ResilienceFlow } from '../components/dashboard/ResilienceFlow'
import type { AnomaliesEnvelope, IncidentsEnvelope } from '../types/api'

function heroSentence(
  healthy: number,
  total: number,
  activeIncidents: number,
  anomalous: number,
): string {
  if (total === 0) return 'Waiting for the gateway to report in.'
  if (activeIncidents > 0)
    return `${activeIncidents} active ${activeIncidents === 1 ? 'incident' : 'incidents'} — the platform is absorbing it.`
  if (anomalous > 0) return 'A statistical anomaly needs a look.'
  if (healthy === total) return 'Your services are behaving normally.'
  return `${healthy} of ${total} services reporting healthy.`
}

export function OverviewPage() {
  const { services, metrics, history, connected } = useGatewayData()
  const incidents = usePolling(() => api.incidents(), { intervalMs: 5_000 })
  const anomalies = usePolling(() => api.anomalies(), { intervalMs: 6_000 })

  const totals = metrics.data?.totals
  const successRate =
    totals !== undefined && totals.requestCount > 0
      ? totals.successCount / totals.requestCount
      : null
  const activeCount = incidents.data?.incidents.filter((i) => i.status === 'ACTIVE').length ?? 0
  const anomalousCount =
    anomalies.data?.anomalies.filter((a) => a.status === 'WARNING' || a.status === 'ANOMALOUS')
      .length ?? 0

  // Session throughput: requests seen since the dashboard opened.
  const sessionRequests = history.reduce((sum, point) => sum + point.requests, 0)

  return (
    <div className="flex flex-col gap-10">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <header className="max-w-3xl">
        <p className="mb-3 font-mono text-[11px] tracking-[0.22em] text-lavender uppercase">
          API Resilience · Command Center
        </p>
        <h1 className="font-serif text-4xl leading-[1.1] tracking-tight text-ink sm:text-5xl">
          {connected && services.data !== null ? (
            <>
              {heroSentence(
                services.data.summary.healthy,
                services.data.summary.total,
                activeCount,
                anomalousCount,
              )}
            </>
          ) : connected ? (
            'Listening to your platform…'
          ) : (
            <span className="text-crit">Gateway disconnected.</span>
          )}
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-soft">
          Health, retries, circuits, failovers and statistical anomalies — observed live from the
          gateway at <span className="font-mono text-xs">:4000</span>, explained in plain numbers.
        </p>
      </header>

      {/* ── Stat hierarchy ──────────────────────────────────────────────── */}
      <section aria-label="Platform vitals" className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Panel>
          {metrics.isStale && metrics.data !== null && (
            <StaleNotice onRetry={metrics.refresh} />
          )}
          {metrics.status === 'loading' && metrics.data === null ? (
            <div className="flex flex-col gap-4 p-6">
              <Skeleton className="h-24 w-48" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : metrics.status === 'error' && metrics.data === null ? (
            <ErrorState message="Metrics unavailable." onRetry={metrics.refresh} />
          ) : (
            <div className="grid grid-cols-1 gap-y-8 p-6 sm:grid-cols-[auto_1fr] sm:gap-x-12 sm:gap-y-0">
              {/* Primary metric — deliberately dominant */}
              <div>
                <p className="font-mono text-[10px] tracking-[0.18em] text-faint uppercase">
                  Success rate
                </p>
                <p className="mt-2 font-serif text-6xl tracking-tight text-ink tabular-nums">
                  {fmtPct(successRate, successRate !== null && successRate < 0.999 ? 2 : 1)}
                </p>
                <p className="mt-2 font-mono text-[11px] text-soft">
                  {fmtInt(totals?.requestCount)} requests since boot
                  {sessionRequests > 0 && (
                    <span className="text-faint"> · {fmtInt(sessionRequests)} while you watched</span>
                  )}
                </p>
              </div>

              {/* Secondary stats — quiet rows, not cards */}
              <dl className="grid content-start gap-x-8 gap-y-4 sm:grid-cols-2">
                {[
                  ['Avg latency', fmtMs(totals?.averageLatencyMs)],
                  ['p95 latency', fmtMs(totals?.p95LatencyMs)],
                  ['Timeouts', fmtInt(totals?.timeoutCount)],
                  ['Retries', fmtInt(totals?.retryCount)],
                  ['Failovers', fmtInt(totals?.failoverCount)],
                  ['Circuit opens', fmtInt(totals?.circuitOpenCount)],
                ].map(([label, value]) => (
                  <div key={label} className="border-b border-line pb-3 last:border-none sm:border-b">
                    <dt className="text-xs text-soft">{label}</dt>
                    <dd className="mt-0.5 font-mono text-lg text-ink tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </Panel>

        {/* Service health strip */}
        <Panel as="article">
          <PanelHeader
            title="Service health"
            action={
              services.data !== null ? (
                <Badge tone={services.data.summary.unhealthy === 0 ? 'ok' : 'crit'}>
                  {services.data.summary.healthy}/{services.data.summary.total} healthy
                </Badge>
              ) : undefined
            }
          />
          {services.status === 'loading' && services.data === null ? (
            <LoadingBlock label="Probing providers" />
          ) : services.status === 'error' && services.data === null ? (
            <ErrorState message="Gateway unavailable." onRetry={services.refresh} />
          ) : (
            <ul className="divide-y divide-line">
              {(services.data?.services ?? []).map((service) => (
                <li key={service.name}>
                  <Link
                    to="/services"
                    className="group flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StatusDot
                        tone={healthTone(service.status)}
                        pulse={service.status === 'healthy'}
                      />
                      <span className="truncate font-mono text-xs text-ink">{service.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3 font-mono text-[11px] text-faint group-hover:text-soft">
                      <span>{fmtMs(service.latencyMs)}</span>
                      <StatusDot tone={circuitTone(service.circuit.state)} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      {/* ── Flow + incidents ─────────────────────────────────────────────── */}
      <section aria-label="Resilience flow and incidents" className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle note="the path of one request">Resilience flow</SectionTitle>
          <Panel>
            <ResilienceFlow />
          </Panel>
        </div>

        <div>
          <SectionTitle note="live from /api/incidents">Incidents</SectionTitle>
          <Panel className="flex h-full flex-col">
            <PanelHeader
              title={activeCount > 0 ? `${activeCount} active` : 'No active incidents'}
              hint={
                incidents.data !== null
                  ? `${incidents.data.count} total this session`
                  : undefined
              }
              action={<Siren aria-hidden="true" className="size-4 text-faint" />}
            />
            {incidents.status === 'loading' && incidents.data === null ? (
              <LoadingBlock label="Reading incident log" />
            ) : incidents.status === 'error' && incidents.data === null ? (
              <ErrorState message="Incident log unavailable." onRetry={incidents.refresh} />
            ) : (incidents.data?.incidents.length ?? 0) === 0 ? (
              <EmptyState title="Everything is quiet." note="No incidents recorded yet." />
            ) : (
              <ul className="divide-y divide-line">
                {incidents.data?.incidents.slice(0, 4).map((incident) => (
                  <li key={incident.incidentId}>
                    <Link
                      to="/incidents"
                      className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <StatusDot tone={incident.status === 'ACTIVE' ? 'crit' : 'ok'} pulse={incident.status === 'ACTIVE'} />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] text-ink">{incident.title}</span>
                          <span className="block font-mono text-[10px] text-faint uppercase">
                            {incident.service}
                          </span>
                        </span>
                      </span>
                      <Badge tone={incident.status === 'ACTIVE' ? 'crit' : 'muted'}>
                        {incident.status}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-auto border-t border-line px-5 py-2.5">
              <Link
                to="/incidents"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-lavender transition-colors hover:text-ink"
              >
                Open incident room <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>
          </Panel>
        </div>
      </section>

      {/* ── Anomaly strip ────────────────────────────────────────────────── */}
      <section aria-label="Anomaly overview">
        <SectionTitle note="explainable · rolling baselines">Anomaly intelligence</SectionTitle>
        <Panel>
          {anomalies.status === 'loading' && anomalies.data === null ? (
            <LoadingBlock label="Sampling baselines" />
          ) : anomalies.status === 'error' && anomalies.data === null ? (
            <ErrorState message="Anomaly feed unavailable." onRetry={anomalies.refresh} />
          ) : (anomalies.data?.anomalies.length ?? 0) === 0 ? (
            <EmptyState
              title="Not enough observations yet."
              note="Baselines appear once traffic flows through the gateway."
            />
          ) : (
            <ul className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
              {anomalies.data?.anomalies.map((report) => (
                <li key={report.service} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2.5 font-mono text-xs text-ink">
                    <StatusDot tone={anomalyTone(report.status)} pulse={report.status === 'ANOMALOUS'} />
                    {report.service}
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span
                      className={cx(
                        'font-mono text-sm tabular-nums',
                        report.status === 'ANOMALOUS'
                          ? 'text-crit'
                          : report.status === 'WARNING'
                            ? 'text-warn'
                            : 'text-soft',
                      )}
                    >
                      {report.score === null ? '—' : report.score.toFixed(2)}
                    </span>
                    <span className="font-mono text-[10px] tracking-wide text-faint uppercase">
                      {ANOMALY_LABEL[report.status]}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  )
}

// Re-export for potential reuse in tests/stories.
export type { IncidentsEnvelope, AnomaliesEnvelope }
