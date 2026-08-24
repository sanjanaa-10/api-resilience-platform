import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react'
import { cx } from '../../lib/format'

/** First-load placeholder block with consistent height. */
export function LoadingBlock({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${label}`}
      className={cx('flex items-center gap-3 px-5 py-6 text-sm text-faint', className)}
    >
      <RefreshCw aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      {label}…
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  message: string
  onRetry?: () => void
  compact?: boolean
}) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-start gap-3 px-5',
        compact ? 'py-4' : 'py-8',
      )}
    >
      <div className="flex items-center gap-2.5 text-warn">
        {message.toLowerCase().includes('unavailable') ? (
          <WifiOff aria-hidden="true" className="size-4" />
        ) : (
          <AlertTriangle aria-hidden="true" className="size-4" />
        )}
        <p className="text-sm font-medium">{message}</p>
      </div>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-lavender-wash hover:text-lavender"
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Retry
        </button>
      )}
    </div>
  )
}

/** Deliberate quiet state — used for "everything is calm" moments. */
export function EmptyState({
  title,
  note,
}: {
  title: string
  note?: string
}) {
  return (
    <div className="flex flex-col gap-1 px-5 py-8">
      <p className="font-serif text-[15px] text-soft italic">{title}</p>
      {note !== undefined && <p className="text-xs text-faint">{note}</p>}
    </div>
  )
}

/** Thin notice shown when data exists but refreshes are failing. */
export function StaleNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line bg-peach-wash/60 px-5 py-2">
      <p className="flex items-center gap-2 text-xs text-warn">
        <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
        Live updates interrupted — showing the last known state.
      </p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-gold/50 px-2 py-0.5 font-mono text-[10px] tracking-wide text-warn uppercase transition-colors hover:bg-surface"
        >
          Retry now
        </button>
      )}
    </div>
  )
}
