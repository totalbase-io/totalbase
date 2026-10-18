/**
 * Viewport and device queries for layout logic that CSS alone can't
 * express - a `hidden md:flex` element still mounts (and fetches its data),
 * a design surface must know not to persist a phone-width layout, a modal
 * picks `fullscreen`. All reactive (a resize or a rotation updates them)
 * and read on setup - the admin is an SPA (nuxt.config `ssr: false`).
 *
 * Which one to reach for:
 * - `useIsMobile()` - the screen is narrow (below `md`, 768px): there's no
 *   room, whatever the device. The app layout's own switch point.
 * - `useIsTouch()` - the device is driven by a finger (phones, tablets),
 *   whatever the width. Never a user agent sniff (an iPad reports as a Mac).
 * - `useCompactUi()` - either, or narrower than `lg` (1024px): the phone-style
 *   version of a component, on a phone, on a tablet, and in any window too
 *   narrow for a rail, a menu and the page side by side.
 *
 * One `matchMedia` listener per query for the whole app, not one per call:
 * every rendered widget asks these (74 call sites - a CUSTOM page with 50
 * widgets registered 150 listeners), and a shared ref answers them all.
 * The listener is attached once, on the first call, and never removed - the
 * query outlives any component, like `window` itself.
 */

/** The shared ref of each query, created on its first use (client only - `window` is read lazily). */
const SHARED_QUERIES = new Map<string, Readonly<Ref<boolean>>>()

/** Any media query, kept in sync. The building block of the ones below. */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const shared = SHARED_QUERIES.get(query)
  if (shared) return shared
  // No `window` (a unit test, a build-time render): a fixed "doesn't match".
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return readonly(ref(false))
  const list = window.matchMedia(query)
  const matches = ref(list.matches)
  list.addEventListener('change', (e: MediaQueryListEvent) => {
    matches.value = e.matches
  })
  const result = readonly(matches)
  SHARED_QUERIES.set(query, result)
  return result
}

/** Below Tailwind's `md` (768px) - where the layout swaps the rail for the mobile header. */
export function useIsMobile(): Readonly<Ref<boolean>> {
  return useMediaQuery('(max-width: 767px)')
}

/** A finger is the primary pointer (`pointer: coarse`) - a phone or a tablet, a touch-only laptop mode too. */
export function useIsTouch(): Readonly<Ref<boolean>> {
  return useMediaQuery('(pointer: coarse)')
}

/** Below Tailwind's `lg` (1024px) - a tablet's width, whatever its pointer (an iPad with a trackpad reads `fine`). */
export function useIsNarrow(): Readonly<Ref<boolean>> {
  return useMediaQuery('(max-width: 1023px)')
}

/** `useCompactUi()`'s one shared answer - a computed per call would be cheap, but one is simpler still. */
let compactUi: Readonly<Ref<boolean>> | undefined

/**
 * A touch device, or a screen narrower than `lg` - see the doc comment above. Below 1024px a rail and a menu beside
 * the page leave it too little room (T66): the navigation is the slideover, as on a phone.
 */
export function useCompactUi(): Readonly<Ref<boolean>> {
  if (!compactUi) {
    const isNarrow = useIsNarrow()
    const isTouch = useIsTouch()
    compactUi = computed(() => isNarrow.value || isTouch.value)
  }
  return compactUi
}
