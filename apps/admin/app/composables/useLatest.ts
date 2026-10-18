/**
 * The newest of a watcher's async loads wins. `next()` marks a load as the
 * current one and hands back its token; `isCurrent()` turns false the moment
 * a later load starts, so a response that arrives late is dropped instead
 * of overwriting the fresh one - the stale guard every watcher-driven fetch
 * (a search box, an inspector's lookups, a grid's totals) needs.
 *
 *   const latest = useLatest()
 *   watch(term, async (value) => {
 *     const load = latest.next()
 *     const rows = await api.get(...)
 *     if (!load.isCurrent()) return
 *     results.value = rows
 *   })
 */
export function useLatest() {
  let current = 0
  return {
    next() {
      const token = ++current
      return { isCurrent: () => token === current }
    },
    /** Drops every load in flight with no successor - for a reset. */
    invalidate() {
      current += 1
    }
  }
}
