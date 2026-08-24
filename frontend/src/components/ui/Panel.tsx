import type { ReactNode } from 'react'
import { cx } from '../../lib/format'

/** Soft layered surface — the base container of the whole UI. */
export function Panel({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'article' | 'div' | 'aside'
}) {
  return (
    <Tag
      className={cx(
        'rounded-2xl border border-line bg-surface shadow-soft transition-colors duration-200',
        className,
      )}
    >
      {children}
    </Tag>
  )
}

export function PanelHeader({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="font-mono text-[11px] tracking-[0.14em] text-soft uppercase">{title}</h2>
        {hint !== undefined && <p className="mt-0.5 truncate text-xs text-faint">{hint}</p>}
      </div>
      {action}
    </div>
  )
}

/** Editorial section heading used between panels on pages. */
export function SectionTitle({
  children,
  note,
}: {
  children: ReactNode
  note?: string
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4">
      <h2 className="font-serif text-xl tracking-tight text-ink">{children}</h2>
      {note !== undefined && <p className="font-mono text-[11px] text-faint">{note}</p>}
    </div>
  )
}

/** Skeleton shimmer placeholder for first-load states. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-surface-2', className)} aria-hidden="true" />
}
