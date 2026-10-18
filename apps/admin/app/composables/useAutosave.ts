/**
 * Autosave for the pillar editors (Dashboards, Workflows, DataViews):
 * every edit goes into the draft on its own - the draft is never what users
 * see, and Publish is the one deliberate step (Specification.md §13).
 *
 * - `schedule()` saves after `delay` ms of quiet (typing, dragging);
 * - `track(promise)` reports an immediate save the editor already made
 *   (a canvas move, a checkbox) through the same status;
 * - `flush()` runs a scheduled save now and waits for every save in
 *   flight - Publish calls it first so it never publishes a stale draft.
 *
 * `save` runs strictly one at a time: an edit while a save is in flight
 * queues exactly one more run, never two concurrent writes of the draft.
 */
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export function useAutosave(save: () => Promise<void>, options: { delay?: number } = {}) {
  const delay = options.delay ?? 800
  const status = ref<AutosaveStatus>('idle')
  const error = ref<unknown>(null)

  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | null = null
  let rerun = false
  const tracked = new Set<Promise<unknown>>()

  function settle(outcome: 'saved' | 'error', err?: unknown) {
    if (outcome === 'error') {
      status.value = 'error'
      error.value = err
    } else if (!running && tracked.size === 0 && timer === undefined && status.value !== 'error') {
      status.value = 'saved'
    }
  }

  async function run(): Promise<void> {
    if (running) {
      rerun = true
      return running
    }
    status.value = 'saving'
    error.value = null
    running = (async () => {
      try {
        do {
          rerun = false
          await save()
        } while (rerun)
        running = null
        settle('saved')
      } catch (err) {
        running = null
        settle('error', err)
      }
    })()
    return running
  }

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    status.value = 'saving'
    timer = setTimeout(() => {
      timer = undefined
      run()
    }, delay)
  }

  async function track<T>(promise: Promise<T>): Promise<T> {
    tracked.add(promise)
    status.value = 'saving'
    error.value = null
    try {
      const result = await promise
      tracked.delete(promise)
      settle('saved')
      return result
    } catch (err) {
      tracked.delete(promise)
      settle('error', err)
      throw err
    }
  }

  async function flush() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
      await run()
    } else if (running) {
      await running
    }
    await Promise.allSettled([...tracked])
    if (status.value === 'error') throw error.value
  }

  onBeforeUnmount(() => {
    // Leaving the editor with an edit still debouncing: save it now.
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
      run()
    }
  })

  return { status, error, schedule, track, flush, retry: run }
}
