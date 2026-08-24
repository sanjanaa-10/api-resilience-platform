import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useGatewayData } from '../hooks/useGatewayData'
import { usePolling } from '../hooks/usePolling'
import { api } from '../services/api'
import { EVENT_TYPES, EVENT_SEVERITIES, type EventType, type EventSeverity } from '../types/api'
import { Panel, PanelHeader, SectionTitle } from '../components/ui/Panel'
import { EmptyState, ErrorState, LoadingBlock, StaleNotice } from '../components/ui/Feedback'
import { Badge } from '../components/ui/status'
import { EventRow } from '../components/events/EventRow'

const LIMITS = [100, 200, 500] as const

const SELECT_CLASS =
  'rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-lavender'

export function EventsPage() {
  const { services } = useGatewayData()
  const [service, setService] = useState('')
  const [type, setType] = useState('')
  const [severity, setSeverity] = useState('')
  const [limit, setLimit] = useState<number>(200)
  const [search, setSearch] = useState('')

  const serviceNames = useMemo(
    () => (services.data?.services ?? []).map((s) => s.name),
    [services.data],
  )

  const events = usePolling(
    () => api.events({ service: service || undefined, type: type || undefined, severity: severity || undefined, limit }),
    { intervalMs: 4_000 },
  )

  const { refresh } = events

  // Refetch immediately when filters change instead of waiting a tick.
  useEffect(() => {
    refresh()
  }, [service, type, severity, limit, refresh])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return events.data?.events ?? []
    return (events.data?.events ?? []).filter(
      (event) =>
        event.message.toLowerCase().includes(needle) ||
        event.service.toLowerCase().includes(needle) ||
        (event.requestId?.toLowerCase().includes(needle) ?? false),
    )
  }, [events.data, search])

  return (
    <div className="flex flex-col gap-8">
      <header>
        <SectionTitle note={events.data !== null ? `${events.data.count} matching · newest first` : undefined}>
          Event stream
        </SectionTitle>
        <p className="max-w-xl text-sm leading-relaxed text-soft">
          The gateway's raw memory — every retry, timeout, breaker transition and anomaly verdict,
          straight from the observability ring buffer.
        </p>
      </header>

      {events.isStale && events.data !== null && <StaleNotice onRetry={events.refresh} />}

      {/* Filters */}
      <Panel className="px-5 py-4">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3" role="search">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wide text-faint uppercase">Service</span>
            <select value={service} onChange={(e) => setService(e.target.value)} className={SELECT_CLASS}>
              <option value="">All services</option>
              {serviceNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wide text-faint uppercase">Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)} className={SELECT_CLASS}>
              <option value="">All types</option>
              {EVENT_TYPES.map((t: EventType) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wide text-faint uppercase">Severity</span>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={SELECT_CLASS}>
              <option value="">All severities</option>
              {EVENT_SEVERITIES.map((s: EventSeverity) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wide text-faint uppercase">Limit</span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number.parseInt(e.target.value, 10))}
              className={SELECT_CLASS}
            >
              {LIMITS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>

          <label className="flex min-w-[220px] flex-1 flex-col gap-1">
            <span className="text-[10px] tracking-wide text-faint uppercase">Search</span>
            <span className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="message, service or request id…"
                className="w-full rounded-lg border border-line bg-surface py-1.5 pr-2.5 pl-8 font-mono text-xs text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-lavender"
              />
            </span>
          </label>
        </div>
      </Panel>

      {/* Stream */}
      {events.status === 'loading' && events.data === null ? (
        <Panel>
          <LoadingBlock label="Opening the event log" />
        </Panel>
      ) : events.status === 'error' && events.data === null ? (
        <Panel>
          <ErrorState message="Event stream unavailable." onRetry={events.refresh} />
        </Panel>
      ) : visible.length === 0 ? (
        <Panel>
          {(events.data?.count ?? 0) > 0 ? (
            <EmptyState title="No events match those filters." note="Loosen a filter or clear the search." />
          ) : (
            <EmptyState
              title="The stream is silent."
              note="Events appear the moment requests flow through the gateway."
            />
          )}
        </Panel>
      ) : (
        <Panel>
          <PanelHeader
            title="Live feed"
            hint={`${visible.length} shown${search.trim() !== '' ? ` of ${events.data?.count ?? 0}` : ''}`}
            action={<Badge tone="muted">polling 4s</Badge>}
          />
          <ul className="divide-y divide-line">
            {visible.slice(0, 150).map((event) => (
              <EventRow key={event.eventId} event={event} />
            ))}
          </ul>
          {visible.length > 150 && (
            <p className="border-t border-line px-5 py-2 font-mono text-[10px] tracking-wide text-faint uppercase">
              showing first 150 of {visible.length} — narrow with filters or search
            </p>
          )}
        </Panel>
      )}
    </div>
  )
}
