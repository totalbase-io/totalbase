/**
 * The maintenance batch (Settings > Maintenance, Administration.md §6.5), shared
 * by the page's batch modal and the Settings menu's "running" indicator.
 * Its state lives in PostgreSQL - this only mirrors it: one poll for the
 * whole app, every 2s while a batch is active and someone is watching,
 * none otherwise (GET .../batches/current once when a watcher mounts).
 */
import type { MaintenanceBatch } from '~/types/maintenance'

const POLL_MS = 2000
let timer: ReturnType<typeof setTimeout> | undefined
let watchers = 0

export function useMaintenanceBatch() {
  const api = useAdminApi()
  const batch = useState<MaintenanceBatch | null>('maintenance-batch', () => null)

  async function load(): Promise<void> {
    clearTimeout(timer)
    try {
      // A known batch is followed by id, so it can still be shown once it
      // has finished; otherwise ask whether one is running.
      batch.value = batch.value
        ? (await api.get<MaintenanceBatch>(`/maintenance/batches/${batch.value.id}`)).data
        : (await api.get<MaintenanceBatch | null>('/maintenance/batches/current')).data
    } catch {
      // A failed poll just tries again on the next tick.
    }
    if (watchers > 0 && batch.value?.active) timer = setTimeout(load, POLL_MS)
  }

  /** Start following (on mount); `stop` on unmount - polling ends with the last watcher. */
  function watch() {
    watchers += 1
    if (watchers === 1) load()
  }
  function stop() {
    watchers = Math.max(0, watchers - 1)
    if (watchers === 0) clearTimeout(timer)
  }

  /** A batch just started (or was stopped): show it and follow it. */
  function follow(next: MaintenanceBatch) {
    batch.value = next
    clearTimeout(timer)
    if (next.active) timer = setTimeout(load, POLL_MS)
  }

  /** The finished batch's summary was dismissed. */
  function clear() {
    if (!batch.value?.active) batch.value = null
  }

  return { batch, load, watch, stop, follow, clear }
}
