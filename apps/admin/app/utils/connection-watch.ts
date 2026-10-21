/**
 * Whether a kiosk page can reach TotalBase (DataViews.md §7.3):
 * the browser's own offline state (`navigator.onLine`, its `online` and
 * `offline` events) and, while it says online, a light probe of the server
 * (`/health/live`) - a network that is up but can't reach the server reads
 * the same to a person at a totem. Online only: nothing is queued.
 */

export type ConnectionProblem = 'offline' | 'unreachable' | null

export interface ConnectionWatchOptions {
  /** What is probed - a GET that answers 2xx while the server is up. */
  url: string
  /** Between probes while it is reachable, and while it isn't (sooner, to clear the notice soon). */
  everyMs?: number
  retryMs?: number
  /** Injected in tests; the browser's by default. */
  fetch?: (url: string) => Promise<{ ok: boolean }>
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  isOnline?: () => boolean
}

export function createConnectionWatch(onChange: (problem: ConnectionProblem) => void, options: ConnectionWatchOptions) {
  const everyMs = options.everyMs ?? 15_000
  const retryMs = options.retryMs ?? 3_000
  const request = options.fetch ?? ((url: string) => fetch(url, { cache: 'no-store' }))
  const target = options.target ?? window
  const isOnline = options.isOnline ?? (() => navigator.onLine !== false)

  let online = isOnline()
  let reachable = true
  let problem: ConnectionProblem = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const update = () => {
    const next: ConnectionProblem = !online ? 'offline' : !reachable ? 'unreachable' : null
    if (next === problem) return
    problem = next
    onChange(next)
  }
  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = stopped || !online ? null : setTimeout(() => void probe(), reachable ? everyMs : retryMs)
  }
  async function probe() {
    try {
      reachable = (await request(options.url)).ok
    } catch {
      reachable = false
    }
    if (stopped) return
    update()
    schedule()
  }
  const onOnline = () => {
    online = true
    update()
    void probe()
  }
  const onOffline = () => {
    online = false
    update()
    schedule()
  }

  target.addEventListener('online', onOnline)
  target.addEventListener('offline', onOffline)
  update()
  schedule()

  return {
    /** Probes now - after a request failed to reach the server, say. */
    probe: () => void probe(),
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      target.removeEventListener('online', onOnline)
      target.removeEventListener('offline', onOffline)
    }
  }
}
