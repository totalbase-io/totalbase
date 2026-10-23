import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestLimiter, rateLimitedUntil, retryAfterMs, retryingRateLimit } from './rate-limit'

const refused = (retryAfter?: string) => ({ response: { status: 429, headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}) } })

describe('retryAfterMs', () => {
  it('reads a 429\'s Retry-After, capped at a minute, 5 s without one; null for anything else', () => {
    expect(retryAfterMs(refused('12'))).toBe(12_000)
    expect(retryAfterMs(refused('600'))).toBe(60_000)
    expect(retryAfterMs(refused())).toBe(5_000)
    expect(retryAfterMs({ response: { status: 500, headers: new Headers() } })).toBeNull()
    expect(retryAfterMs(new Error('network'))).toBeNull()
  })
})

describe('retryingRateLimit', () => {
  afterEach(() => vi.useRealTimers())

  it('sends a read again after the wait, and shows the wait meanwhile', async () => {
    vi.useFakeTimers()
    const send = vi.fn().mockRejectedValueOnce(refused('2')).mockResolvedValueOnce('ok')
    const result = retryingRateLimit(true, send)
    await vi.advanceTimersByTimeAsync(0)
    expect(rateLimitedUntil.value).toBeGreaterThan(Date.now())
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toBe('ok')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('gives up after its retries, and never retries a write or another failure', async () => {
    vi.useFakeTimers()
    const always = vi.fn().mockRejectedValue(refused('1'))
    const read = retryingRateLimit(true, always).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await read).toEqual(refused('1'))
    expect(always).toHaveBeenCalledTimes(3)

    const write = vi.fn().mockRejectedValue(refused('1'))
    await expect(retryingRateLimit(false, write)).rejects.toEqual(refused('1'))
    expect(write).toHaveBeenCalledTimes(1)
    const broken = vi.fn().mockRejectedValue(new Error('500'))
    await expect(retryingRateLimit(true, broken)).rejects.toThrow('500')
    expect(broken).toHaveBeenCalledTimes(1)
  })
})

describe('createRequestLimiter', () => {
  it('runs at most `max` at once, the newest waiting job next', async () => {
    const limiter = createRequestLimiter(2)
    const started: number[] = []
    const releases: Array<() => void> = []
    const job = (n: number) => () => new Promise<number>((resolve) => {
      started.push(n)
      releases.push(() => resolve(n))
    })
    const results = [1, 2, 3, 4].map(n => limiter.run(job(n)))
    expect(started).toEqual([1, 2])
    releases[0]!()
    await results[0]
    await Promise.resolve()
    expect(started).toEqual([1, 2, 4])
    releases[1]!()
    releases[2]!()
    await Promise.all(results.slice(0, 2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(started).toEqual([1, 2, 4, 3])
    releases[3]!()
    await expect(Promise.all(results)).resolves.toEqual([1, 2, 3, 4])
  })
})
