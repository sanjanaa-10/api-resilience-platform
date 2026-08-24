import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'
import { cx } from '../../lib/format'

/**
 * Three-state theme switch (light / system / dark) rendered as a segmented
 * control. Keyboard accessible via radiogroup semantics.
 */
export function ThemeToggle() {
  const { mode, setMode } = useTheme()

  const options = [
    { value: 'light', label: 'Light theme', icon: Sun },
    { value: 'system', label: 'System theme', icon: Monitor },
    { value: 'dark', label: 'Dark theme', icon: Moon },
  ] as const

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="flex items-center gap-0.5 rounded-full border border-line bg-surface-2 p-0.5"
    >
      {options.map((option) => {
        const active = mode === option.value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => setMode(option.value)}
            className={cx(
              'rounded-full p-1.5 transition-colors duration-200',
              active
                ? 'bg-surface text-lavender shadow-soft'
                : 'text-faint hover:text-soft',
            )}
          >
            <Icon aria-hidden="true" className="size-[15px]" />
          </button>
        )
      })}
    </div>
  )
}
