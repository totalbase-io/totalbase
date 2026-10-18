// Per-page UI preferences (page size, visible columns, sidebar state,
// etc.) - browser-local only via localStorage, never persisted server-side
// (this is "how you like to look at the data", not application state).
export function usePagePreferences<T extends Record<string, unknown>>(key: string, defaults: T): T {
  const storageKey = `totalbase:page:${key}`
  const state = reactive({ ...defaults }) as T

  if (import.meta.client) {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) Object.assign(state, JSON.parse(raw))
    } catch {
      // Corrupt/inaccessible localStorage (private mode, quota, etc.) -
      // fall back to defaults rather than break the page over a preference.
    }
  }

  watch(
    () => ({ ...state }),
    (value) => {
      if (!import.meta.client) return
      try {
        localStorage.setItem(storageKey, JSON.stringify(value))
      } catch {
        // Same as above - a failed write just means the preference doesn't
        // stick this session, not worth surfacing to the user.
      }
    },
    { deep: true }
  )

  return state
}
