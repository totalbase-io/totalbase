import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionWatch, type ConnectionProblem } from '~/utils/connection-watch'

describe('createConnectionWatch()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(online = true) {
    const target = new EventTarget()
    const changes: ConnectionProblem[] = []
    let up = true
    const fetch = vi.fn(async () => ({ ok: up }))
    const watch = createConnectionWatch(problem => changes.push(problem), { url: '/health/live', everyMs: 15_000, retryMs: 3_000, fetch, target, isOnline: () => online })
    const setUp = (value: boolean) => {
      up = value
    }
    return { target, changes, fetch, watch, setUp }
  }

  it('says nothing while online and reachable, probing every 15 s', async () => {
    const { changes, fetch, watch } = setup()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(changes).toEqual([])
    watch.stop()
  })

  it('tells offline at once and clears it when the browser is back online', async () => {
    const { target, changes, watch } = setup()
    target.dispatchEvent(new Event('offline'))
    expect(changes).toEqual(['offline'])
    target.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual(['offline', null])
    watch.stop()
  })

  it('starts offline when the browser is', () => {
    const { changes, watch } = setup(false)
    expect(changes).toEqual(['offline'])
    watch.stop()
  })

  it('tells an unreachable server, retries sooner and clears once it answers', async () => {
    const { changes, fetch, watch, setUp } = setup()
    setUp(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(changes).toEqual(['unreachable'])
    setUp(true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(changes).toEqual(['unreachable', null])
    expect(fetch).toHaveBeenCalledTimes(2)
    watch.stop()
  })

  it('reads a failed request as unreachable', async () => {
    const target = new EventTarget()
    const changes: ConnectionProblem[] = []
    const watch = createConnectionWatch(problem => changes.push(problem), { url: '/health/live', fetch: () => Promise.reject(new TypeError('Failed to fetch')), target, isOnline: () => true })
    watch.probe()
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual(['unreachable'])
    watch.stop()
  })

  it('stops probing once stopped', async () => {
    const { fetch, watch } = setup()
    watch.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).not.toHaveBeenCalled()
  })
})
