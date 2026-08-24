import { useGatewayData } from '../hooks/useGatewayData'
import { usePolling } from '../hooks/usePolling'
import { api } from '../services/api'
import { fmtInt, fmtMs, timeHMS } from '../lib/format'
import { Panel, PanelHeader, SectionTitle } from '../components/ui/Panel'
import { ErrorState, StaleNotice } from '../components/ui/Feedback'
import {
  Badge,
  StatusDot,
  anomalyTone,
  circuitTone,
  healthLabel,
  healthTone,
  ANOMALY_LABEL,
} from '../components/ui/status'
import type { AnomalyStatusReport, ServiceStatusWithCircuit } from '../types/api'

function ServiceCard({
  service,
  anomaly,
}: {
  service: ServiceStatusWithCircuit
  anomaly: AnomalyStatusReport | undefined
}) {
  const { metrics } = useGatewayData()
  const stats = metrics.data?.services[service.name]

  return (
    <Panel as="article" className="transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={healthTone(service.status)} pulse={service.status === 'healthy'} />
          <span className="min-w-0">
            <span className="block truncate font-mono text-xs tracking-[0.06em] text-ink">
              {service.name}
            </span>
            <span className="block truncate text-[11px] text-faint">{service.displayName}</span>
          </span>
        </span>
        <Badge
          tone={
            service.status === 'healthy' ? 'ok' : service.status === 'unhealthy' ? 'crit' : 'muted'
          }
        >
          {healthLabel(service.status)}
        </Badge>
      </div>

      <dl className="grid grid-cols-3 divide-x divide-line border-b border-line">
        {[
          ['Latency', fmtMs(service.latencyMs)],
          ['Requests', fmtInt(stats?.requestCount)],
          ['Errors', fmtInt(stats?.failureCount)],
        ].map(([label, value]) => (
          <div key={label} className="px-4 py-2.5">
            <dt className="text-[10px] tracking-wide text-faint uppercase">{label}</dt>
            <dd className="mt-0.5 font-mono text-sm text-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <Badge tone={circuitTone(service.circuit.state) === 'crit' ? 'crit' : circuitTone(service.circuit.state) === 'warn' ? 'warn' : 'ok'}>
          circuit {service.circuit.state}
        </Badge>
        <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-faint uppercase">
          <StatusDot tone={anomaly === undefined ? 'muted' : anomalyTone(anomaly.status)} />
          {anomaly === undefined ? 'no anomaly data' : ANOMALY_LABEL[anomaly.status]}
        </span>
      </div>

      {(service.lastError !== null || service.consecutiveFailures > 0) && (
        <p className="truncate border-t border-line px-5 py-2 font-mono text-[10px] text-crit">
          {service.lastError !== null
            ? service.lastError.slice(0, 90)
            : `${service.consecutiveFailures} consecutive failures`}
        </p>
      )}
    </Panel>
  )
}

export function ServicesPage() {
  const { services } = useGatewayData()
  const anomalies = usePolling(() => api.anomalies(), { intervalMs: 6_000 })

  const anomalyByService = new Map(
    (anomalies.data?.anomalies ?? []).map((report) => [report.service, report]),
  )

  return (
    <div className="flex flex-col gap-8">
      <header>
        <SectionTitle note={`${services.data?.summary.total ?? '—'} registered providers`}>
          Services
        </SectionTitle>
        <p className="max-w-xl text-sm leading-relaxed text-soft">
          Every provider with its probe latency, live traffic counters, breaker state and the
          anomaly detector's current verdict.
        </p>
      </header>

      {services.isStale && services.data !== null && <StaleNotice onRetry={services.refresh} />}

      {services.status === 'loading' && services.data === null ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
          {[1, 2, 3, 4].map((n) => (
            <Panel key={n}>
              <div className="flex flex-col gap-3 p-5">
                <div className="h-4 w-28 rounded bg-surface-2" />
                <div className="h-10 rounded bg-surface-2" />
                <div className="h-6 rounded bg-surface-2" />
              </div>
            </Panel>
          ))}
        </div>
      ) : services.status === 'error' && services.data === null ? (
        <Panel>
          <ErrorState message="Gateway unavailable." onRetry={services.refresh} />
        </Panel>
      ) : (
        <>
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4" aria-label="Service cards">
            {(services.data?.services ?? []).map((service) => (
              <ServiceCard
                key={service.name}
                service={service}
                anomaly={anomalyByService.get(service.name)}
              />
            ))}
          </div>

          <Panel>
            <PanelHeader title="Probe details" hint="from /api/services · refreshed continuously" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
                    <th scope="col" className="px-5 py-2.5 font-medium">Provider</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Base URL</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Checked</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Consecutive failures</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Circuit since</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(services.data?.services ?? []).map((service) => (
                    <tr key={service.name} className="transition-colors hover:bg-surface-2">
                      <td className="px-5 py-2.5 font-mono text-xs text-ink">{service.name}</td>
                      <td className="px-5 py-2.5 font-mono text-[11px] text-faint">{service.baseUrl}</td>
                      <td className="px-5 py-2.5 font-mono text-xs text-soft tabular-nums">
                        {timeHMS(service.lastCheckedAt)}
                      </td>
                      <td className="px-5 py-2.5 font-mono text-xs tabular-nums">
                        <span className={service.consecutiveFailures > 0 ? 'text-crit' : 'text-soft'}>
                          {service.consecutiveFailures}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 font-mono text-xs text-soft tabular-nums">
                        {service.circuit.state === 'CLOSED' ? '—' : timeHMS(service.circuit.openedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
