import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cx, durationBetween, timeHMS } from '../../lib/format'
import { StatusDot, severityTone } from '../ui/status'
import type { Incident } from '../../types/api'

/**
 * Narrative incident timeline — chronological, severity-colored rail with
 * expandable entries. The story reads top-to-bottom like the incident report
 * an engineer would write.
 */
export function IncidentTimeline({ incident }: { incident: Incident }) {
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <ol className="relative flex flex-col px-5 py-4" aria-label="Incident timeline">
      {/* Rail */}
      <span
        aria-hidden="true"
        className="absolute top-7 bottom-7 left-[calc(1.25rem+52px)] w-px bg-line"
      />
      {incident.timeline.map((entry, index) => {
        const open = expanded === index
        const uniqueId = `${incident.incidentId}-${index}`
        return (
          <li key={uniqueId} className={cx('relative flex gap-4', index > 0 && 'mt-0.5')}>
            <time
              dateTime={entry.timestamp}
              className="w-[44px] shrink-0 pt-[3px] text-right font-mono text-[10px] leading-5 text-faint"
            >
              {timeHMS(entry.timestamp)}
            </time>

            <span className="relative z-10 mt-[6px] flex size-3 shrink-0 items-center justify-center">
              <StatusDot tone={severityTone(entry.severity)} className="size-[9px]" />
            </span>

            <div className="min-w-0 flex-1 pb-3">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`${uniqueId}-detail`}
                onClick={() => setExpanded(open ? null : index)}
                className="group flex w-full items-start justify-between gap-2 rounded-md py-px pr-1 text-left"
              >
                <span
                  className={cx(
                    'text-[13px] leading-5 transition-colors',
                    entry.severity === 'CRITICAL'
                      ? 'text-crit'
                      : entry.severity === 'WARNING'
                        ? 'text-warn'
                        : 'text-ink',
                    'group-hover:text-lavender',
                  )}
                >
                  {entry.message}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cx(
                    'mt-0.5 size-3.5 shrink-0 text-faint transition-transform duration-200',
                    open && 'rotate-180',
                  )}
                />
              </button>
              <p
                id={`${uniqueId}-detail`}
                hidden={!open}
                className="mt-1 font-mono text-[10px] tracking-wide text-faint uppercase"
              >
                {entry.eventType} · {entry.severity}
                {entry.requestId !== null && (
                  <>
                    {' '}
                    · req {entry.requestId.slice(0, 8)}
                  </>
                )}
              </p>
            </div>
          </li>
        )
      })}

      {incident.status === 'RESOLVED' && incident.endedAt !== null && (
        <li className="flex gap-4">
          <time
            dateTime={incident.endedAt}
            className="w-[44px] shrink-0 pt-[3px] text-right font-mono text-[10px] text-faint"
          >
            {timeHMS(incident.endedAt)}
          </time>
          <span className="relative z-10 mt-[6px] flex size-3 shrink-0 items-center justify-center">
            <StatusDot tone="ok" className="size-[9px]" />
          </span>
          <p className="pb-1 text-[13px] text-ok">
            Resolved · lasted {durationBetween(incident.startedAt, incident.endedAt)}
          </p>
        </li>
      )}
    </ol>
  )
}
