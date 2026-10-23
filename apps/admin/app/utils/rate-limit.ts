import { ref } from 'vue'

/**
 * Living with the instance's rate limit (security.rate_limit_per_minute,
 * per IP - Administration.md §7.7): a request refused with 429
 * RATE_LIMIT_EXCEEDED waits what its Retry-After says and goes again,
 * rather than failing the screen, and the screens that fetch one thing per
 * row (thumbnails, file details) go through a limiter instead of all at once.
 */

/** Until when (epoch ms) the server asked to wait - app.vue tells the user while it lasts. */
export const rateLimitedUntil = ref(0)

const DEFAULT_WAIT_MS = 5_000
const MAX_WAIT_MS = 60_000

/** How long a 429 asks to wait (its Retry-After, capped); null for any other failure. */
export function retryAfterMs(error: unknown): number | null {
  const response = (error as { response?: { status?: number, headers?: Headers } } | null)?.response
  if (response?.status !== 429) return null
  const seconds = Number(response.headers?.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : DEFAULT_WAIT_MS
}

const RETRIES = 2

/**
 * `send()`, sent again after the wait a 429 asks for (up to RETRIES times)
 * when `retry` - a read, which the refusal kept from running at all.
 */
export async function retryingRateLimit<T>(retry: boolean, send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (error) {
      const wait = retry && attempt < RETRIES ? retryAfterMs(error) : null
      if (wait === null) throw error
      await waitOutRateLimit(wait)
    }
  }
}

/** Waits `ms`, the wait shown to the user meanwhile. */
export function waitOutRateLimit(ms: number): Promise<void> {
  rateLimitedUntil.value = Math.max(rateLimitedUntil.value, Date.now() + ms)
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * At most `max` jobs at once; the rest wait, the newest first - what was
 * just scrolled into view before what scrolled past.
 */
export function createRequestLimiter(max: number) {
  const queue: Array<() => Promise<void>> = []
  let active = 0

  function pump() {
    while (active < max && queue.length > 0) {
      const next = queue.pop()!
      active++
      void next().finally(() => {
        active--
        pump()
      })
    }
  }

  function run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => job().then(resolve, reject))
      pump()
    })
  }

  return { run }
}

/** The one limiter every per-row file request shares (useFileObjectUrl, useFileInfo). */
export const fileRequests = createRequestLimiter(6)
