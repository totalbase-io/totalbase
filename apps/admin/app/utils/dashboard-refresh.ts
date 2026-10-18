/**
 * A dashboard widget's auto-refresh timer (Specification_Dashboards.md §9.4):
 * re-runs `run` every `intervalMs`, counted from the end of the previous run,
 * so two runs never overlap however slow the query is. It pauses while the
 * browser tab is hidden and, once visible again, runs at once if a run fell
 * due meanwhile (otherwise it waits out the rest of the interval).
 *
 * Plain `setTimeout`/`Date.now()`, so fake timers (vitest, Playwright's
 * `page.clock`) drive it.
 */

/** The part of `document` the scheduler reads - injectable for tests. */
export interface RefreshVisibility {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface DashboardRefreshScheduler {
  /** Starts counting the first interval from now. */
  start(): void
  stop(): void
  /** Counts the interval again from now - after a run something else triggered (Refresh, a variable change). */
  restart(): void
}

export interface DashboardRefreshOptions {
  intervalMs: number
  /** One run; its settling (fulfilled or rejected) starts the next interval. */
  run: () => Promise<unknown>
  /** Default: the page's `document` (none = always visible). */
  visibility?: RefreshVisibility | null
}

export function createDashboardRefreshScheduler(options: DashboardRefreshOptions): DashboardRefreshScheduler {
  const visibility = options.visibility === undefined
    ? (typeof document === 'undefined' ? null : document)
    : options.visibility
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let active = false
  let lastRunAt = 0

  const hidden = () => visibility?.visibilityState === 'hidden'

  function clear() {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function schedule() {
    clear()
    if (!active || running || hidden()) return
    timer = setTimeout(tick, Math.max(0, lastRunAt + options.intervalMs - Date.now()))
  }

  async function tick() {
    timer = null
    if (!active || hidden()) return
    running = true
    try {
      await options.run()
    } catch {
      // The run reports its own error (the card shows it); the timer keeps going.
    } finally {
      running = false
      lastRunAt = Date.now()
      schedule()
    }
  }

  function onVisibilityChange() {
    if (hidden()) clear()
    else schedule()
  }

  return {
    start() {
      if (active) return
      active = true
      lastRunAt = Date.now()
      visibility?.addEventListener('visibilitychange', onVisibilityChange)
      schedule()
    },
    stop() {
      active = false
      clear()
      visibility?.removeEventListener('visibilitychange', onVisibilityChange)
    },
    restart() {
      lastRunAt = Date.now()
      schedule()
    }
  }
}
