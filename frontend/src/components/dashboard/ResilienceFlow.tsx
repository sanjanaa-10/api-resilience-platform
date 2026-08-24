import { ArrowDown, ShieldCheck, Zap } from 'lucide-react'
import { useGatewayData } from '../../hooks/useGatewayData'
import { cx } from '../../lib/format'
import { Badge, StatusDot, healthTone } from '../ui/status'
import type { ServiceStatusWithCircuit } from '../../types/api'

type ConnectorTone = 'muted' | 'crit' | 'ok' | 'accent'

const STROKE: Record<ConnectorTone, string> = {
  muted: 'var(--line-strong)',
  crit: 'var(--rose)',
  ok: 'var(--mint)',
  accent: 'var(--lavender)',
}

function Connector({
  label,
  tone = 'muted',
  flowing = false,
}: {
  label?: string
  tone?: ConnectorTone
  flowing?: boolean
}) {
  return (
    <div className="relative flex h-8 w-full items-center justify-center" aria-hidden="true">
      <svg width="2" height="32" className="absolute left-1/2 -translate-x-1/2">
        <line
          x1="1"
          y1="0"
          x2="1"
          y2="32"
          stroke={STROKE[tone]}
          strokeWidth="2"
          strokeDasharray={flowing ? '4 4' : undefined}
          className={cx(flowing && 'animate-flow motion-reduce:animate-none')}
        />
      </svg>
      {label !== undefined && (
        <span
          className={cx(
            'absolute rounded-md border bg-surface px-2 py-px font-mono text-[9px] tracking-[0.12em] uppercase',
            tone === 'crit'
              ? 'border-rose/40 text-crit'
              : tone === 'accent'
                ? 'border-lavender/40 text-lavender'
                : 'border-line text-faint',
          )}
        >
          {label}
        </span>
      )}
    </div>
  )
}

function FlowNode({
  title,
  subtitle,
  right,
  emphasis = false,
}: {
  title: string
  subtitle?: string
  right?: React.ReactNode
  emphasis?: boolean
}) {
  return (
    <div
      className={cx(
        'flex w-full max-w-[340px] items-center justify-between gap-3 rounded-xl border px-4 py-2.5 transition-colors duration-300',
        emphasis
          ? 'border-lavender/50 bg-lavender-wash shadow-soft'
          : 'border-line bg-surface',
      )}
    >
      <div className="min-w-0">
        <p className="truncate font-mono text-xs tracking-[0.08em] text-ink uppercase">{title}</p>
        {subtitle !== undefined && (
          <p className="mt-0.5 truncate font-mono text-[10px] tracking-wide text-faint">
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </div>
  )
}

function ProviderBadge({ provider }: { provider: ServiceStatusWithCircuit }) {
  const serving = provider.status === 'healthy' && provider.circuit.state === 'CLOSED'
  const label = serving
    ? 'Healthy'
    : provider.status === 'unhealthy'
      ? 'Down'
      : provider.circuit.state === 'OPEN'
        ? 'Circuit open'
        : provider.circuit.state === 'HALF_OPEN'
          ? 'Probing'
          : 'Unknown'
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <StatusDot tone={healthTone(provider.status)} pulse={provider.status !== 'unhealthy'} />
      <span
        className={cx(
          'font-mono text-[10px] tracking-[0.1em] uppercase',
          provider.status === 'unhealthy' || provider.circuit.state === 'OPEN'
            ? 'text-crit'
            : 'text-soft',
        )}
      >
        {label}
      </span>
    </span>
  )
}

/**
 * Signature visual: the request's journey through the platform, driven by
 * REAL state — health + circuit from /api/services, failover activity from
 * the live metrics counters and recent FAILOVER_* events in the stream.
 */
export function ResilienceFlow() {
  const { services, metrics } = useGatewayData()

  if (services.data === null) {
    return (
      <p className="px-5 py-6 text-sm text-faint">Topology appears once services load.</p>
    )
  }

  const byName = new Map(services.data.services.map((s) => [s.name, s]))
  const primary = byName.get('ai-primary')
  const fallback = byName.get('ai-fallback')

  if (primary === undefined || fallback === undefined) {
    return <p className="px-5 py-6 text-sm text-faint">Provider group unavailable.</p>
  }

  const primaryBroken =
    primary.circuit.state === 'OPEN' ||
    primary.circuit.state === 'HALF_OPEN' ||
    primary.status === 'unhealthy'

  // Honest "serving" signal: the gateway only reports failovers that happened.
  const failoverActive = primaryBroken && (metrics.data?.totals.failoverCount ?? 0) > 0

  return (
    <div className="flex flex-col items-center px-5 py-6" data-testid="resilience-flow">
      <FlowNode
        title="Client"
        subtitle="any HTTP consumer"
        right={<Zap aria-hidden="true" className="size-4 text-faint" />}
      />
      <Connector tone="accent" flowing label="request" />
      <FlowNode
        title="Gateway :4000"
        subtitle="requestId · retry · timeout"
        right={
          <Badge tone="accent">
            <ShieldCheck aria-hidden="true" className="size-3" /> Guarding
          </Badge>
        }
      />
      <Connector label="token bucket" />

      {/* Primary branch */}
      <div className="w-full max-w-[340px]">
        <div
          className={cx(
            'flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 transition-colors duration-300',
            primaryBroken
              ? 'border-rose/50 bg-rose-wash'
              : 'border-line bg-surface',
          )}
        >
          <div className="min-w-0">
            <p className="font-mono text-xs tracking-[0.08em] text-ink uppercase">AI Primary</p>
            <p className="mt-0.5 font-mono text-[10px] text-faint">
              {primary.latencyMs !== null ? `${Math.round(primary.latencyMs)}ms probe` : 'no probe yet'}
            </p>
          </div>
          <ProviderBadge provider={primary} />
        </div>

        {primaryBroken && (
          <div className="mt-1.5 flex items-center justify-center gap-2" role="status">
            <Badge tone="crit">attempt failed</Badge>
            <ArrowDown aria-hidden="true" className="size-3.5 text-crit" />
          </div>
        )}
      </div>

      <Connector
        tone={primaryBroken ? 'crit' : 'ok'}
        flowing={!primaryBroken}
        label={primaryBroken ? 'circuit open' : `circuit ${primary.circuit.state.toLowerCase()}`}
      />

      {/* Failover branch — only emphasized when the backend actually failed over */}
      <div className="w-full max-w-[340px]">
        <div
          className={cx(
            'flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 transition-colors duration-300',
            failoverActive
              ? 'border-mint/60 bg-mint-wash shadow-soft'
              : 'border-line bg-surface opacity-80 transition-opacity',
          )}
        >
          <div className="min-w-0">
            <p className="font-mono text-xs tracking-[0.08em] text-ink uppercase">AI Fallback</p>
            <p className="mt-0.5 font-mono text-[10px] text-faint">
              {failoverActive ? 'serving the ai group' : 'standby'}
            </p>
          </div>
          {failoverActive ? (
            <Badge tone="ok">
              <StatusDot tone="ok" pulse /> Serving
            </Badge>
          ) : (
            <ProviderBadge provider={fallback} />
          )}
        </div>
      </div>

      <Connector tone={failoverActive ? 'ok' : 'muted'} flowing={failoverActive} label="response" />

      <p className="mt-1 max-w-[340px] text-center text-[11px] leading-relaxed text-faint">
        {failoverActive
          ? 'Traffic is being served while the primary recovers.'
          : 'Failover path stands by — budget of one hop per request.'}
      </p>
    </div>
  )
}
