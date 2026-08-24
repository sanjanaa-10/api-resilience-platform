import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  CircuitBoard,
  Gauge,
  Menu,
  RadioTower,
  ScrollText,
  Siren,
  X,
} from 'lucide-react'
import { useGatewayData } from '../../hooks/useGatewayData'
import { cx } from '../../lib/format'
import { ThemeToggle } from '../ui/ThemeToggle'

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: Gauge },
  { to: '/services', label: 'Services', icon: CircuitBoard },
  { to: '/incidents', label: 'Incidents', icon: Siren },
  { to: '/anomalies', label: 'Anomalies', icon: Activity },
  { to: '/metrics', label: 'Resilience', icon: RadioTower },
  { to: '/events', label: 'Events', icon: ScrollText },
] as const

function LiveIndicator(): React.JSX.Element {
  const { connected, metrics } = useGatewayData()
  return (
    <span
      className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] uppercase"
      title={
        connected
          ? `Streaming from the gateway${metrics.lastUpdatedAt !== null ? ' (last update just now)' : ''}`
          : 'Cannot reach the gateway'
      }
    >
      <span
        aria-hidden="true"
        className={cx(
          'size-[7px] rounded-full',
          connected ? 'animate-breathe bg-mint motion-reduce:animate-none' : 'bg-rose',
        )}
      />
      <span className={connected ? 'text-soft' : 'text-crit'}>
        {connected ? 'Live' : 'Offline'}
      </span>
    </span>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)

  const navLinks = (
    <>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            cx(
              'group relative inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors duration-200',
              'focus-visible:outline-2 focus-visible:outline-lavender',
              isActive ? 'text-ink' : 'text-soft hover:bg-surface-2 hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <span
                aria-hidden="true"
                className={cx(
                  'absolute -bottom-[13px] left-3 right-3 h-[2px] rounded-full bg-lavender transition-opacity duration-200',
                  isActive ? 'opacity-100' : 'opacity-0',
                )}
              />
              <item.icon aria-hidden="true" className={cx('size-4', isActive && 'text-lavender')} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </>
  )

  return (
    <div className="flex min-h-dvh flex-col">
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-4 px-5 lg:px-8">
          <div className="flex items-center gap-8">
            <NavLink to="/" className="flex items-baseline gap-2 focus-visible:outline-2">
              <span className="font-serif text-lg tracking-tight text-ink">
                Resilience<span className="text-lavender italic"> Command</span>
              </span>
            </NavLink>
            <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
              {navLinks}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <span className="hidden items-center gap-2 sm:flex">
              <LiveIndicator />
            </span>
            <ThemeToggle />
            <button
              type="button"
              className="rounded-lg p-2 text-soft hover:bg-surface-2 hover:text-ink md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {/* Mobile navigation */}
        {menuOpen && (
          <nav
            id="mobile-nav"
            aria-label="Primary mobile"
            className="border-t border-line bg-bg px-5 pt-2 pb-4 md:hidden"
          >
            <ul className="flex flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    onClick={() => setMenuOpen(false)}
                    className={({ isActive }) =>
                      cx(
                        'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm',
                        isActive
                          ? 'bg-lavender-wash text-ink'
                          : 'text-soft hover:bg-surface-2 hover:text-ink',
                      )
                    }
                  >
                    <item.icon aria-hidden="true" className="size-4 text-lavender" />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>

      {/* ── Main area ─────────────────────────────────────────────────────── */}
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-8 lg:px-8">{children}</main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2 px-5 py-4 lg:px-8">
          <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
            <AlertTriangle aria-hidden="true" className="size-3" />
            Explainable detection · rolling baselines · no black boxes
          </p>
          <p className="font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
            Gateway :4000 · Phase 10
          </p>
        </div>
      </footer>
    </div>
  )
}
