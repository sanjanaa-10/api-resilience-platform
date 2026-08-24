import { useMemo, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../services/api'
import { cx, timeHMS } from '../lib/format'
import { Panel, PanelHeader, SectionTitle } from '../components/ui/Panel'
import { EmptyState, ErrorState, LoadingBlock, StaleNotice } from '../components/ui/Feedback'
import { Badge, StatusDot, anomalyTone } from '../components/ui/status'
import { AnomalyPanel, METRIC_LABEL } from '../components/anomalies/AnomalyPanel'
import type { AssessmentRecord } from '../types/api'

function HistoryRow({ record }: { record: AssessmentRecord }) {
  return (
    <li className="flex items-center gap-3 px-5 py-2">
      <StatusDot tone={anomalyTone(record.status)} />
      <span className="w-[52px] shrink-0 font-mono text-[11px] text-faint tabular-nums">
        {timeHMS(record.timestamp)}
      </span>
      <span className="flex-1 truncate font-mono text-xs text-soft">
        {record.topMetric !== null ? METRIC_LABEL[record.topMetric] : '—'}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-ink">
        {record.score === null ? '—' : record.score.toFixed(2)}
      </span>
    </li>
  )
}

export function AnomaliesPage() {
  const anomalies = usePolling(() => api.anomalies(), { intervalMs: 6_000 })
  const [pinnedService, setPinnedService] = useState<string | null>(null)

  const reports = useMemo(
    () => anomalies.data?.anomalies ?? [],
    [anomalies.data],
  )

  // Derived selection: pinned service while present, otherwise the most
  // interesting report. No effect needed — it follows the data naturally.
  const selectedService =
    reports.find((r) => r.service === pinnedService)?.service ??
    (reports.find((r) => r.status === 'ANOMALOUS') ??
      reports.find((r) => r.status === 'WARNING') ??
      reports[0])?.service ??
    null

  const report = useMemo(
    () => reports.find((r) => r.service === selectedService) ?? null,
    [reports, selectedService],
  )

  const history = usePolling<AssessmentRecord[]>(
    () =>
      selectedService !== null
        ? api.anomalyHistory(selectedService).then((envelope) =>
            [...envelope.history].reverse(),
          )
        : Promise.resolve([]),
    { intervalMs: 12_000 },
  )

  return (
    <div className="flex flex-col gap-8">
      <header>
        <SectionTitle note="median · MAD · robust z-score">Anomaly intelligence</SectionTitle>
        <p className="max-w-2xl text-sm leading-relaxed text-soft">
          Each service is compared against its own rolling baseline using explainable statistics.
          Every verdict ships with the exact numbers behind it — control-chart logic, not a
          predictive model.
        </p>
      </header>

      {anomalies.isStale && anomalies.data !== null && <StaleNotice onRetry={anomalies.refresh} />}

      {anomalies.status === 'loading' && anomalies.data === null ? (
        <Panel>
          <LoadingBlock label="Sampling baselines" />
        </Panel>
      ) : anomalies.status === 'error' && anomalies.data === null ? (
        <Panel>
          <ErrorState message="Anomaly feed unavailable." onRetry={anomalies.refresh} />
        </Panel>
      ) : reports.length === 0 ? (
        <Panel>
          <EmptyState
            title="Not enough observations yet."
            note="Baselines appear once traffic flows through the gateway."
          />
        </Panel>
      ) : (
        <>
          {/* Service selector */}
          <div role="tablist" aria-label="Tracked services" className="flex flex-wrap gap-2">
            {reports.map((entry) => (
              <button
                key={entry.service}
                role="tab"
                type="button"
                aria-selected={entry.service === selectedService}
                onClick={() => setPinnedService(entry.service)}
                className={cx(
                  'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-xs transition-colors',
                  entry.service === selectedService
                    ? 'border-lavender bg-lavender-wash text-ink'
                    : 'border-line bg-surface text-soft hover:border-line-strong hover:text-ink',
                )}
              >
                <StatusDot tone={anomalyTone(entry.status)} pulse={entry.status === 'ANOMALOUS'} />
                {entry.service}
              </button>
            ))}
          </div>

          <div className="grid items-start gap-6 xl:grid-cols-[1fr_320px]">
            {report !== null && <AnomalyPanel report={report} />}

            {/* Assessment history */}
            <Panel as="aside">
              <PanelHeader
                title="Recent assessments"
                hint={selectedService !== null ? `${selectedService} · newest first` : undefined}
                action={
                  <Badge tone="muted">{history.data?.length ?? 0} kept</Badge>
                }
              />
              {history.status === 'loading' && history.data === null ? (
                <LoadingBlock label="Reading history" />
              ) : history.status === 'error' && history.data === null ? (
                <ErrorState message="History unavailable." onRetry={history.refresh} compact />
              ) : (history.data?.length ?? 0) === 0 ? (
                <EmptyState
                  title="No assessments recorded yet."
                  note="The detector records one assessment per traffic-bearing sampling interval — idle time never fabricates history."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {(history.data ?? []).map((record, index) => (
                    <HistoryRow key={`${record.timestamp}-${index}`} record={record} />
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}
