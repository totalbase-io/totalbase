import { onScopeDispose, readonly, ref, toValue, watch, type Ref, type WatchSource } from 'vue'

/** The one debounce delay of the admin's search boxes - a request after the typing pauses, not per keystroke. */
export const SEARCH_DEBOUNCE_MS = 300

/**
 * A ref that follows `source` once it has been still for `delay` ms - the
 * one debounce of the admin (a grid's search, a list's filter box, a
 * preview's URL), in place of a `setTimeout`/`clearTimeout` pair per
 * component. The returned ref starts at the source's current value, so a
 * request keyed on it runs once at mount, then once per pause in typing.
 * The pending timer is dropped with the scope that created it.
 */
export function useDebouncedRef<T>(source: WatchSource<T>, delay = SEARCH_DEBOUNCE_MS): Readonly<Ref<T>> {
  const debounced = ref(toValue(source)) as Ref<T>
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(source, (value) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      debounced.value = value
    }, delay)
  })
  onScopeDispose(() => clearTimeout(timer))
  return readonly(debounced) as Readonly<Ref<T>>
}
