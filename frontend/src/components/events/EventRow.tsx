import {
  ArrowRightLeft,
  Ban,
  CircleCheck,
  CircleX,
  CornerDownRight,
  Gauge,
  HeartPulse,
  RotateCcw,
  ShieldCheck,
  Siren,
  Timer,
  TriangleAlert,
} from 'lucide-react'
import { cx, eventLabel, timeHMS } from '../../lib/format'
import { severityTone } from '../ui/status'
import type { EventType, ResilienceEvent } from '../../types/api'

const EVENT_ICON: Record<EventType, typeof CircleCheck> = {
  REQUEST_STARTED: CornerDownRight,
  REQUEST_COMPLETED: CircleCheck,
  REQUEST_FAILED: CircleX,
  RETRY_ATTEMPT: RotateCcw,
  RATE_LIMITED: Gauge,
  CIRCUIT_OPENED: Ban,
  CIRCUIT_HALF_OPEN: TriangleAlert,
  CIRCUIT_CLOSED: ShieldCheck,
  FAILOVER_STARTED: ArrowRightLeft,
  FAILOVER_COMPLETED: ArrowRightLeft,
  UPSTREAM_TIMEOUT: Timer,
  HEALTH_CHANGED: HeartPulse,
  ANOMALY_DETECTED: Siren,
  ANOMALY_RESOLVED: CircleCheck,
}

const EVENT_TINT: Partial<Record<EventType, string>> = {
  ANOMALY_DETECTED: 'text-crit',
  CIRCUIT_OPENED: 'text-crit',
  REQUEST_FAILED: 'text-crit',
  UPSTREAM_TIMEOUT: 'text-warn',
  RATE_LIMITED: 'text-warn',
  RETRY_ATTEMPT: 'text-warn',
}

/** One row of the event stream — dense, mono, scannable. */
export function EventRow({ event }: { event: ResilienceEvent }) {
  const Icon = EVENT_ICON[event.eventType]
  return (
    <li className="grid grid-cols-[64px_16px_1fr] items-baseline gap-x-3 px-5 py-2 transition-colors hover:bg-surface-2 sm:grid-cols-[64px_16px_170px_90px_1fr]">
      <time
        dateTime={event.timestamp}
        className="font-mono text-[11px] text-faint tabular-nums"
        title={event.timestamp}
      >
        {timeHMS(event.timestamp)}
      </time>
      <span aria-hidden="true" className="flex justify-center self-center">
        <span className={cx('relative flex size-4 items-center justify-center')}>
          <Icon className={cx('size-3.5', EVENT_TINT[event.eventType] ?? 'text-soft')} />
        </span>
      </span>
      <span
        aria-hidden="true"
        className="hidden items-center gap-2 sm:flex"
        data-severity={severityTone(event.severity)}
      >
        <span
          className={cx(
            'size-1.5 rounded-full',
            event.severity === 'CRITICAL'
              ? 'bg-rose'
              : event.severity === 'WARNING'
                ? 'bg-gold'
                : 'bg-blue',
          )}
        />
        <span className="truncate font-mono text-[11px] text-soft">{eventLabel(event.eventType)}</span>
      </span>
      <span className="hidden truncate font-mono text-[11px] text-faint sm:block">
        {event.service}
      </span>
      <span className="min-w-0 text-[13px] leading-snug text-ink">
        {event.message}
        {event.requestId !== null && (
          <span
            className="ml-2 font-mono text-[10px] text-faint"
            title={`request ${event.requestId}`}
          >
            {event.requestId.slice(0, 8)}
          </span>
        )}
      </span>
    </li>
  )
}
