/** Formatting + tiny class helpers shared across the UI. */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`
  if (value >= 100) return `${Math.round(value)}ms`
  return `${value.toFixed(1)}ms`
}

export function fmtPct(fraction: number | null | undefined, digits = 1): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—'
  return `${(fraction * 100).toFixed(digits)}%`
}

export function fmtSignedPct(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '—'
  const sign = percent > 0 ? '+' : ''
  return `${sign}${Math.round(percent)}%`
}

export function fmtRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  if (rate === 0) return '0%'
  if (rate < 0.005) return '<0.5%'
  return `${(rate * 100).toFixed(1)}%`
}

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}

export function timeHMS(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', TIME_OPTS).format(date)
}

export function timeHM(iso: string | null | undefined): string {
  return timeHMS(iso).slice(0, 5)
}

export function durationBetween(startIso: string, endIso: string | null): string {
  const start = Date.parse(startIso)
  const end = endIso ? Date.parse(endIso) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  let seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** Humanized "x ago" for lastUpdated stamps; falls back gracefully. */
export function agoStamp(msEpoch: number | null): string {
  if (msEpoch === null) return ''
  const seconds = Math.max(0, Math.round((Date.now() - msEpoch) / 1000))
  if (seconds < 3) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

/** Event type label: REQUEST_COMPLETED -> "Request completed". */
export function eventLabel(eventType: string): string {
  const words = eventType.toLowerCase().split('_')
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}
