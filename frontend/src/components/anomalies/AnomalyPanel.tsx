import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { cx } from '../../lib/format'
import { Badge, StatusDot, anomalyTone, ANOMALY_LABEL } from '../ui/status'
import { Panel } from '../ui/Panel'
import type { AnomalyReason, AnomalyStatusReport, MetricKey } from '../../types/api'

export const METRIC_LABEL: Record<MetricKey, string> = {
  avgLatencyMs: 'Average latency',
  p95LatencyMs: 'p95 latency',
  errorRate: 'Error rate',
  timeoutRate: 'Timeout rate',
  retryRate: 'Retry rate',
  failoverRate: 'Failover rate',
}

function formatMetricValue(metric: MetricKey, value: number): string {
  if (metric === 'avgLatencyMs' || metric === 'p95LatencyMs') return `${Math.round(value)}ms`
  if (value === 0) return '0%'
  return `${(value * 100).toFixed(1)}%`
}

const STATUS_EXPLAIN: Record<AnomalyStatusReport['status'], string> = {
  NORMAL: 'Every tracked metric sits inside its rolling baseline.',
  WARNING: 'A metric drifted beyond its usual range. Worth watching.',
  ANOMALOUS:
    'Statistical anomaly detected — a metric is far outside the recent baseline.',
  INSUFFICIENT_DATA:
    'Not enough observations yet. The detector needs more intervals before it will judge.',
}

/** Score dial: a quiet half-arc, not a racing-game gauge. */
function ScoreDial({ score, tone }: { score: number | null; tone: string }) {
  const size = 168
  const stroke = 10
  const radius = (size - stroke) / 2
  const arc = Math.PI * radius
  const progress = score === null ? 0 : Math.min(1, Math.max(0, score))
  const path = `M ${stroke / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - stroke / 2} ${size / 2}`

  return (
    <div className="relative" style={{ width: size, height: size / 2 + 26 }} aria-hidden="true">
      <svg width={size} height={size / 2 + 10} viewBox={`0 0 ${size} ${size / 2 + 10}`}>
        <path d={path} fill="none" stroke="var(--line)" strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={path}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${progress * arc} ${arc}`}
        />
      </svg>
      <p className="absolute inset-x-0 bottom-0 text-center font-serif text-4xl tracking-tight text-ink tabular-nums">
        {score === null ? '—' : score.toFixed(2)}
      </p>
    </div>
  )
}

type ChartRow = AnomalyReason & { label: string }

/** Baseline vs current — one honest paired bar per explained deviation. */
function ReasonChart({ rows }: { rows: ChartRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 64)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 6" stroke="var(--line)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fill: 'var(--ink-faint)', fontSize: 10 }}
          axisLine={{ stroke: 'var(--line)' }}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={140}
          tick={{ fill: 'var(--ink-soft)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          cursor={{ fill: 'var(--surface-2)' }}
          content={({ active, payload }) => {
            if (active !== true || payload === undefined || payload.length === 0) return null
            const row = payload[0]?.payload as ChartRow | undefined
            if (row === undefined) return null
            return (
              <div className="rounded-xl border border-line bg-surface px-3 py-2 shadow-lift">
                <p className="font-mono text-[11px] text-ink">
                  now {formatMetricValue(row.metric, row.current)} · baseline{' '}
                  {formatMetricValue(row.metric, row.baseline)} ({row.changePercent > 0 ? '+' : ''}
                  {Math.round(row.changePercent)}%)
                </p>
                <p className="font-mono text-[10px] text-faint">
                  z-score {row.zScore.toFixed(1)} · robust sigma units
                </p>
              </div>
            )
          }}
        />
        <Bar dataKey="baseline" name="baseline" fill="var(--blue)" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={9} />
        <Bar dataKey="current" name="current" fill="var(--rose)" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={9} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** The full anomaly story for one service: score → status → why. */
export function AnomalyPanel({ report }: { report: AnomalyStatusReport }) {
  const toneHex =
    report.status === 'ANOMALOUS'
      ? 'var(--rose)'
      : report.status === 'WARNING'
        ? 'var(--gold)'
        : report.status === 'NORMAL'
          ? 'var(--mint)'
          : 'var(--ink-faint)'

  const rows: ChartRow[] = report.reasons.map((reason) => ({
    ...reason,
    label: METRIC_LABEL[reason.metric],
  }))

  const badgeTone =
    report.status === 'ANOMALOUS'
      ? 'crit'
      : report.status === 'WARNING'
        ? 'warn'
        : report.status === 'NORMAL'
          ? 'ok'
          : 'muted'

  return (
    <Panel as="article" aria-label={`Anomaly report for ${report.service}`}>
      {/* Score header */}
      <div className="grid gap-6 border-b border-line px-6 py-6 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="flex flex-col items-center">
          <p className="mb-3 font-mono text-[10px] tracking-[0.18em] text-faint uppercase">
            Anomaly score · {report.service}
          </p>
          <ScoreDial score={report.score} tone={toneHex} />
        </div>
        <div className="sm:border-l sm:border-line sm:pl-8">
          <Badge tone={badgeTone}>
            <StatusDot tone={anomalyTone(report.status)} pulse={report.status === 'ANOMALOUS'} />
            {ANOMALY_LABEL[report.status]}
          </Badge>
          <p className={cx('mt-3 max-w-md text-sm leading-relaxed text-soft')}>
            {STATUS_EXPLAIN[report.status]}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-y-1.5 font-mono text-[11px]">
            <dt className="text-left tracking-wide text-faint uppercase">Samples</dt>
            <dd className="text-right text-ink tabular-nums">
              {report.sampleCount} / {report.windowSize} window
            </dd>
            <dt className="text-left tracking-wide text-faint uppercase">Snapshot</dt>
            <dd className="text-right text-ink">{report.timestamp.slice(11, 19)} UTC</dd>
            <dt className="text-left tracking-wide text-faint uppercase">Method</dt>
            <dd className="text-right text-ink">median · MAD · robust z</dd>
          </dl>
        </div>
      </div>

      {/* WHY section */}
      <div className="px-6 py-5">
        <h3 className="font-mono text-[11px] tracking-[0.14em] text-soft uppercase">
          Why this verdict
        </h3>
        {report.status === 'INSUFFICIENT_DATA' || report.reasons.length === 0 ? (
          <p className="mt-3 font-serif text-[15px] text-soft italic">
            {report.status === 'INSUFFICIENT_DATA'
              ? 'No deviation claims yet — the baseline is still forming.'
              : 'No metric crossed the robust-z threshold. Quiet is healthy.'}
          </p>
        ) : (
          <>
            <ul className="mt-3 mb-5 flex flex-col gap-2">
              {report.reasons.map((reason) => (
                <li
                  key={reason.metric}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-2"
                >
                  <span className="text-[13px] text-ink">{METRIC_LABEL[reason.metric]}</span>
                  <span className="flex items-baseline gap-3 font-mono text-xs tabular-nums">
                    <span className="text-blue">base {formatMetricValue(reason.metric, reason.baseline)}</span>
                    <span className="text-crit">now {formatMetricValue(reason.metric, reason.current)}</span>
                    <span className="text-warn">
                      {reason.changePercent > 0 ? '+' : ''}
                      {Math.round(reason.changePercent)}%
                    </span>
                    <span className="rounded border border-line px-1.5 py-px text-[10px] text-soft">
                      z {reason.zScore.toFixed(1)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <ReasonChart rows={rows} />
            <p className="mt-2 text-center font-mono text-[10px] tracking-wide text-faint uppercase">
              baseline vs current · blue / rose
            </p>
          </>
        )}
      </div>
    </Panel>
  )
}
