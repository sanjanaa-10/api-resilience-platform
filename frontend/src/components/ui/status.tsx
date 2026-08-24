import { cx } from '../../lib/format'
import type { AnomalyStatus, CircuitStateName, EventSeverity, IncidentStatus, ProbeStatus } from '../../types/api'

export type DotTone = 'ok' | 'warn' | 'crit' | 'info' | 'muted' | 'accent'

const DOT_TONES: Record<DotTone, string> = {
  ok: 'bg-mint',
  warn: 'bg-gold',
  crit: 'bg-rose',
  info: 'bg-blue',
  muted: 'bg-faint',
  accent: 'bg-lavender',
}

/** Small round status dot; `pulse` adds a calm breathe animation. */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: DotTone
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-[7px] shrink-0 rounded-full',
        DOT_TONES[tone],
        pulse && 'animate-breathe motion-reduce:animate-none',
        className,
      )}
    />
  )
}

const BADGE_TONES: Record<string, string> = {
  ok: 'border-mint/40 bg-mint-wash text-ok',
  warn: 'border-gold/50 bg-peach-wash text-warn',
  crit: 'border-rose/40 bg-rose-wash text-crit',
  info: 'border-blue/40 bg-blue-wash text-blue',
  muted: 'border-line-strong bg-surface-2 text-soft',
  accent: 'border-lavender/45 bg-lavender-wash text-lavender',
}

/** Compact uppercase technical chip used for states and severities. */
export function Badge({
  tone,
  children,
  className,
}: {
  tone: keyof typeof BADGE_TONES
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

// ─── Semantic mappers (single source of status → visual meaning) ─────────────

export function healthTone(status: ProbeStatus): DotTone {
  if (status === 'healthy') return 'ok'
  if (status === 'unhealthy') return 'crit'
  return 'muted'
}

export function healthLabel(status: ProbeStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export function circuitTone(state: CircuitStateName): DotTone {
  if (state === 'CLOSED') return 'ok'
  if (state === 'HALF_OPEN') return 'warn'
  return 'crit'
}

export function severityTone(severity: EventSeverity): DotTone {
  if (severity === 'CRITICAL') return 'crit'
  if (severity === 'WARNING') return 'warn'
  return 'info'
}

export function severityBadgeTone(severity: EventSeverity): keyof typeof BADGE_TONES {
  if (severity === 'CRITICAL') return 'crit'
  if (severity === 'WARNING') return 'warn'
  return 'info'
}

export function incidentBadgeTone(status: IncidentStatus): keyof typeof BADGE_TONES {
  return status === 'ACTIVE' ? 'crit' : 'ok'
}

export const ANOMALY_LABEL: Record<AnomalyStatus, string> = {
  NORMAL: 'Normal',
  WARNING: 'Warning',
  ANOMALOUS: 'Anomalous',
  INSUFFICIENT_DATA: 'Insufficient data',
}

export function anomalyTone(status: AnomalyStatus): DotTone {
  if (status === 'ANOMALOUS') return 'crit'
  if (status === 'WARNING') return 'warn'
  if (status === 'NORMAL') return 'ok'
  return 'muted'
}
