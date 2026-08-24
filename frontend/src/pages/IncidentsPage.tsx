import { useMemo, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../services/api'
import { cx, durationBetween, fmtInt, timeHMS } from '../lib/format'
import { Panel, PanelHeader, SectionTitle } from '../components/ui/Panel'
import { EmptyState, ErrorState, LoadingBlock, StaleNotice } from '../components/ui/Feedback'
import { Badge, StatusDot, incidentBadgeTone } from '../components/ui/status'
import { IncidentTimeline } from '../components/incidents/IncidentTimeline'
import type { Incident } from '../types/api'

function IncidentListItem({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'flex w-full flex-col gap-2 px-5 py-4 text-left transition-colors',
          selected ? 'bg-lavender-wash' : 'hover:bg-surface-2',
        )}
      >
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2.5">
            <StatusDot
              tone={incident.status === 'ACTIVE' ? 'crit' : 'ok'}
              pulse={incident.status === 'ACTIVE'}
            />
            <span className="truncate text-sm text-ink">{incident.title}</span>
          </span>
          <Badge tone={incidentBadgeTone(incident.status)}>{incident.status}</Badge>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[17px] font-mono text-[10px] tracking-wide text-faint uppercase">
          <span>{incident.service}</span>
          <span>{timeHMS(incident.startedAt)}</span>
          <span>
            {incident.status === 'RESOLVED'
              ? `lasted ${durationBetween(incident.startedAt, incident.endedAt)}`
              : `ongoing ${durationBetween(incident.startedAt, null)}`}
          </span>
        </span>
        <span className="flex flex-wrap gap-1.5 pl-[17px]">
          {incident.severity !== 'INFO' && (
            <Badge tone={incident.severity === 'CRITICAL' ? 'crit' : 'warn'}>{incident.severity}</Badge>
          )}
          {incident.circuitOpened && <Badge tone="muted">circuit</Badge>}
          {incident.failoverOccurred && <Badge tone="muted">failover</Badge>}
          <Badge tone="muted">{fmtInt(incident.affectedRequests)} reqs hit</Badge>
        </span>
      </button>
    </li>
  )
}

export function IncidentsPage() {
  const incidents = usePolling(() => api.incidents(), { intervalMs: 5_000 })
  const [pinnedId, setPinnedId] = useState<string | null>(null)

  const list = useMemo(
    () =>
      [...(incidents.data?.incidents ?? [])].sort((a, b) => {
        if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1
        return Date.parse(b.startedAt) - Date.parse(a.startedAt)
      }),
    [incidents.data],
  )

  // Derived selection: the pinned incident while it exists, otherwise the
  // newest/active one. Falls back gracefully as the list shifts underneath us.
  const selected =
    list.find((incident) => incident.incidentId === pinnedId) ?? list[0] ?? null

  return (
    <div className="flex flex-col gap-8">
      <header>
        <SectionTitle note={`${list.filter((i) => i.status === 'ACTIVE').length} active · ${list.length} total`}>
          Incidents
        </SectionTitle>
        <p className="max-w-xl text-sm leading-relaxed text-soft">
          Deterministic narratives assembled from the event stream — what happened, in order,
          with receipts.
        </p>
      </header>

      {incidents.isStale && incidents.data !== null && <StaleNotice onRetry={incidents.refresh} />}

      {incidents.status === 'loading' && incidents.data === null ? (
        <Panel>
          <LoadingBlock label="Opening the incident log" />
        </Panel>
      ) : incidents.status === 'error' && incidents.data === null ? (
        <Panel>
          <ErrorState message="Incident log unavailable." onRetry={incidents.refresh} />
        </Panel>
      ) : list.length === 0 ? (
        <Panel>
          <EmptyState
            title="Everything is quiet."
            note="No incidents recorded. The resilience machinery is idle — which is the point."
          />
        </Panel>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[380px_1fr]">
          {/* List */}
          <Panel>
            <PanelHeader title="Incident log" hint="newest first · active on top" />
            <ul className="divide-y divide-line">
              {list.map((incident) => (
                <IncidentListItem
                  key={incident.incidentId}
                  incident={incident}
                  selected={incident.incidentId === selected?.incidentId}
                  onSelect={() => setPinnedId(incident.incidentId)}
                />
              ))}
            </ul>
          </Panel>

          {/* Detail */}
          {selected !== null && (
            <Panel as="article" aria-label={`Incident ${selected.title}`}>
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-6 py-5">
                <div className="min-w-0">
                  <h3 className="font-serif text-xl tracking-tight text-ink">{selected.title}</h3>
                  <p className="mt-1 max-w-lg text-[13px] leading-relaxed text-soft">
                    {selected.summary}
                  </p>
                </div>
                <Badge tone={incidentBadgeTone(selected.status)}>
                  <StatusDot tone={selected.status === 'ACTIVE' ? 'crit' : 'ok'} pulse={selected.status === 'ACTIVE'} />
                  {selected.status}
                </Badge>
              </div>

              <dl className="grid grid-cols-2 divide-line border-b border-line sm:grid-cols-4 sm:divide-x">
                {[
                  ['Service', selected.service],
                  ['Started', timeHMS(selected.startedAt)],
                  ['Events', fmtInt(selected.eventCount)],
                  ['Affected requests', fmtInt(selected.affectedRequests)],
                ].map(([label, value]) => (
                  <div key={label} className="px-6 py-3">
                    <dt className="text-[10px] tracking-wide text-faint uppercase">{label}</dt>
                    <dd className="mt-0.5 truncate font-mono text-sm text-ink">{value}</dd>
                  </div>
                ))}
              </dl>

              {(selected.failoverOccurred || selected.circuitOpened) && (
                <div className="flex flex-wrap gap-2 border-b border-line bg-surface-2/60 px-6 py-2.5">
                  {selected.circuitOpened && <Badge tone="crit">circuit opened</Badge>}
                  {selected.failoverOccurred && <Badge tone="warn">traffic failed over</Badge>}
                </div>
              )}

              <IncidentTimeline incident={selected} />
            </Panel>
          )}
        </div>
      )}
    </div>
  )
}
