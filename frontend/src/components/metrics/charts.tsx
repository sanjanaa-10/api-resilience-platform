import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { MetricPoint } from '../../hooks/useGatewayData'

const AXIS = {
  stroke: 'var(--ink-faint)',
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
} as const

function timeLabel(t: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(t))
}

interface TooltipEntryView {
  name?: unknown
  value?: unknown
  color?: unknown
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100)
  return String(value ?? '—')
}

/** Quiet surface tooltip shared by every chart. */
function ChartTooltipBody({
  active,
  payload,
  label,
  labelFormatter,
}: {
  active?: boolean
  payload?: readonly TooltipEntryView[]
  label?: unknown
  labelFormatter: (t: number) => string
}) {
  if (active !== true || payload === undefined || payload.length === 0) return null
  const heading = typeof label === 'number' ? labelFormatter(label) : String(label ?? '')
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 shadow-lift">
      <p className="mb-1 font-mono text-[10px] tracking-wide text-faint uppercase">{heading}</p>
      {payload.map((entry, index) => (
        <p key={index} className="flex items-center gap-2 font-mono text-[11px] text-ink">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full"
            style={{ background: typeof entry.color === 'string' ? entry.color : undefined }}
          />
          {typeof entry.name === 'string' ? entry.name : String(entry.name ?? '')}:{' '}
          <span className="tabular-nums">{formatValue(entry.value)}</span>
        </p>
      ))}
    </div>
  )
}

/** Binds a formatter into the shared tooltip body as a render function. */
function makeTooltipContent(labelFormatter: (t: number) => string) {
  return ({
    active,
    payload,
    label,
  }: {
    active?: boolean
    payload?: readonly TooltipEntryView[]
    label?: unknown
  }) => (
    <ChartTooltipBody
      active={active}
      payload={payload}
      label={label}
      labelFormatter={labelFormatter}
    />
  )
}

/** Requests per sampling interval — the platform's pulse. */
export function ThroughputChart({ history }: { history: MetricPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="flowFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--lavender)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--lavender)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(t: number) => timeLabel(t)}
          tick={AXIS}
          axisLine={{ stroke: 'var(--line)' }}
          tickLine={false}
          minTickGap={48}
        />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          content={makeTooltipContent(timeLabel)}
        />
        <Area
          type="monotone"
          dataKey="requests"
          name="requests / interval"
          stroke="var(--lavender)"
          strokeWidth={2}
          fill="url(#flowFill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Success fraction per interval, mint, pinned to a calm 0–100% band. */
export function SuccessRateChart({ history }: { history: MetricPoint[] }) {
  const data = history.map((point) => ({
    ...point,
    successPct: point.successRate === null ? null : point.successRate * 100,
  }))
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 6" stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(t: number) => timeLabel(t)}
          tick={AXIS}
          axisLine={{ stroke: 'var(--line)' }}
          tickLine={false}
          minTickGap={48}
        />
        <YAxis
          domain={[90, 100]}
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip content={makeTooltipContent(timeLabel)} />
        <Line
          type="monotone"
          dataKey="successPct"
          name="success %"
          stroke="var(--mint)"
          strokeWidth={2}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/**
 * p95 latency per tracked provider over the session. Real values only:
 * services without samples simply do not draw yet.
 */
export function LatencyChart({
  history,
  services,
}: {
  history: MetricPoint[]
  services: string[]
}) {
  const palette = ['var(--blue)', 'var(--peach)', 'var(--mint)', 'var(--rose)']
  const data = history.map((point) => {
    const row: Record<string, number | null> & { t: number } = { t: point.t }
    for (const service of services) {
      row[service] = point.latencies[service]?.p95 ?? null
    }
    return row
  })

  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 6" stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(t: number) => timeLabel(t)}
          tick={AXIS}
          axisLine={{ stroke: 'var(--line)' }}
          tickLine={false}
          minTickGap={48}
        />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={52} />
        <Tooltip content={makeTooltipContent(timeLabel)} />
        {services.map((service, index) => (
          <Line
            key={service}
            type="monotone"
            dataKey={service}
            name={`${service} p95`}
            stroke={palette[index % palette.length]}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

