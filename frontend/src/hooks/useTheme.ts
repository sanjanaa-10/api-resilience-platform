import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'system' | 'dark'
export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'resilience.theme'

function systemMode(): ThemeMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    /* storage unavailable */
  }
  return 'system'
}

function apply(mode: ThemeMode): void {
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.style.colorScheme = mode
}

/**
 * Theme system: three-state preference (light / system / dark) persisted to
 * localStorage. System is the default on first visit and stays live-tracking
 * until the user picks an explicit side. The inline script in index.html
 * applies the resolved class pre-mount so there is no flash of wrong theme.
 */
export function useTheme(): {
  preference: ThemePreference
  mode: ThemeMode
  setMode: (next: ThemePreference) => void
} {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference)

  // OS theme can flip underneath a 'system' preference; bump to re-derive.
  const [, setOsTick] = useState(0)
  const resolved: ThemeMode = preference === 'system' ? systemMode() : preference

  useEffect(() => {
    apply(resolved)
    try {
      localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      /* non-fatal */
    }
  }, [preference, resolved])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setOsTick((tick) => tick + 1)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setMode = useCallback((next: ThemePreference) => setPreference(next), [])

  return { preference, mode: resolved, setMode }
}
