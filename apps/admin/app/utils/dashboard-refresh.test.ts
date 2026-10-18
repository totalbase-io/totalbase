import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDashboardRefreshScheduler, type RefreshVisibility } from './dashboard-refresh'

/** A `document` whose visibility the test flips. */
function fakeVisibility() {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: 'visibilitychange', listener: () => void) => listeners.add(listener),
    removeEventListener: (_: 'visibilitychange', listener: () => void) => listeners.delete(listener),
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state
      for (const listener of listeners) listener()
    },
    listeners
  }
  return doc satisfies RefreshVisibility
}

/** A run that stays in flight until the test settles it. */
function deferredRun() {
  const settle: Array<() => void> = []
  const run = vi.fn(() => new Promise<void>((resolve) => {
    settle.push(resolve)
  }))
  const finish = async () => {
    settle.shift()?.()
    await vi.advanceTimersByTimeAsync(0)
  }
  return { run, finish }
}

describe('createDashboardRefreshScheduler()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs once per interval, counted from the end of the previous run', async () => {
    const run = vi.fn(async () => {})
    const scheduler = createDashboardRefreshScheduler({ intervalMs: 30_000, run, visibility: fakeVisibility() })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never overlaps: a slow run delays the next one instead of piling up', async () => {
    const { run, finish } = deferredRun()
    const scheduler = createDashboardRefreshScheduler({ intervalMs: 30_000, run, visibility: fakeVisibility() })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(1)
    // Still in flight two intervals later: nothing else starts.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await finish()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('keeps going after a failed run', async () => {
    const run = vi.fn(async () => {
      throw new Error('statement timeout')
    })
    const scheduler = createDashboardRefreshScheduler({ intervalMs: 60_000, run, visibility: fakeVisibility() })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('pauses while the tab is hidden and catches up once on return', async () => {
    const visibility = fakeVisibility()
    const run = vi.fn(async () => {})
    const scheduler = createDashboardRefreshScheduler({ intervalMs: 30_000, run, visibility })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10_000)
    visibility.set('hidden')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(run).not.toHaveBeenCalled()
    // Overdue: one run at once, not one per missed interval.
    visibility.set('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.stop()
    expect(visibility.listeners.size).toBe(0)
  })

  it('waits out the rest of the interval when the tab returns before a run is due', async () => {
    const visibility = fakeVisibility()
    const run = vi.fn(async () => {})
    const scheduler = createDashboardRefreshScheduler({ intervalMs: 30_000, run, visibility })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10_000)
    visibility.set('hidden')
    await vi.advanceTimersByTimeAsync(5_000)
    visibility.set('visible')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('restart() counts the interval again from now - a manual Refresh resets the countdown', async () => {
    const run = vi.fn(async () => {})
    const scheduler = createDashboardRefreshScheduler({ intervalMs: 30_000, run, visibility: fakeVisibility() })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(20_000)
    scheduler.restart()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })
})
