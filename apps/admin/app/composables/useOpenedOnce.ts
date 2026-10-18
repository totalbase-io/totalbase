import type { Ref } from 'vue'

/**
 * True from the first time `open` becomes true, and forever after - for a
 * Lazy panel/modal/form: nothing loads until someone opens it, and once
 * mounted it stays mounted so it can animate closed and reopen at once.
 */
export function useOpenedOnce(open: Ref<boolean>): Readonly<Ref<boolean>> {
  const opened = ref(open.value)
  watch(open, (isOpen) => {
    if (isOpen) opened.value = true
  })
  return opened
}
