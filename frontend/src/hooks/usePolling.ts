import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClientError } from '../services/api'

export type PollStatus = 'loading' | 'ready' | 'error'

export interface PollingState<T> {
  data: T | null
  /** Last good payload even while erroring/stale — enables graceful degradation. */
  error: string | null
  status: PollStatus
  /** True when data exists but the latest refresh(es) failed. */
  isStale: boolean
  lastUpdatedAt: number | null
  refresh: () => void
}

export interface PollingOptions {
  intervalMs: number
  /** Skip polling while the tab is hidden; resumes on visibility. */
  pauseWhenHidden?: boolean
}

/**
 * Single-interval polling hook. Never stacks intervals: one timer per hook,
 * cleaned up on unmount, paused when the tab hides (optional), keeping the
 * last good data so the UI degrades to "stale" instead of blank.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  options: PollingOptions,
): PollingState<T> {
  const { intervalMs, pauseWhenHidden = true } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<PollStatus>('loading')
  const [isStale, setIsStale] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [, setTick] = useState(0)

  const fetcherRef = useRef(fetcher)

  const inFlight = useRef(false)
  const mounted = useRef(true)

  // Keep the latest fetcher without touching refs during render.
  useEffect(() => {
    fetcherRef.current = fetcher
  })

  const run = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const next = await fetcherRef.current()
      if (!mounted.current) return
      setData(next)
      setError(null)
      setStatus('ready')
      setIsStale(false)
      setLastUpdatedAt(Date.now())
    } catch (caught) {
      if (!mounted.current) return
      setError(
        caught instanceof ApiClientError || caught instanceof Error
          ? caught.message
          : 'Unknown error.',
      )
      setStatus((prev) => (prev === 'loading' ? 'error' : prev))
      setIsStale(true)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void run()

    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null) return
      timer = setInterval(() => {
        if (pauseWhenHidden && document.hidden) return
        void run()
      }, intervalMs)
    }
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    start()

    const onVisibility = (): void => {
      // Refresh immediately on return so the UI catches up after a hidden period.
      if (!document.hidden) void run()
    }
    if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisibility)

    return () => {
      mounted.current = false
      stop()
      if (pauseWhenHidden) document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs, pauseWhenHidden, run])

  const refresh = useCallback(() => {
    void run()
  }, [run])

  // Keep relative "x ago" labels honest without extra requests.
  useEffect(() => {
    const ticker = setInterval(() => setTick((n) => n + 1), 5_000)
    return () => clearInterval(ticker)
  }, [])

  return { data, error, status, isStale, lastUpdatedAt, refresh }
}
