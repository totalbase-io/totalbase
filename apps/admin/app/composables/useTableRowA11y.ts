import type { ComponentPublicInstance, Ref } from 'vue'

/**
 * A UTable whose rows open something (`on-select`, T59, axe nested-interactive): Nuxt UI gives each row
 * `role="button"`, though a row holds its own controls - the selection checkbox, the record's "⋮" - and a button may
 * not contain others. The row keeps its plain table semantics and stays focusable; Enter or Space on a focused row
 * opens it, as a click does (Nuxt UI handles only the click).
 */
export function useTableRowA11y(target: Ref<HTMLElement | ComponentPublicInstance | null>) {
  let observer: MutationObserver | undefined
  let root: Element | undefined
  const strip = (el: Element) => {
    for (const row of el.querySelectorAll('tr[data-slot="tr"][role="button"]')) row.removeAttribute('role')
  }
  const onKeydown = (event: Event) => {
    const key = (event as KeyboardEvent).key
    const row = event.target as HTMLElement
    if ((key !== 'Enter' && key !== ' ') || row.tagName !== 'TR' || row.dataset.slot !== 'tr') return
    event.preventDefault()
    row.click()
  }
  watch(target, (value) => {
    observer?.disconnect()
    root?.removeEventListener('keydown', onKeydown)
    const el = value instanceof Element ? value : (value as ComponentPublicInstance | null)?.$el as Element | undefined
    if (!el || !(el instanceof Element)) return
    root = el
    strip(el)
    el.addEventListener('keydown', onKeydown)
    observer = new MutationObserver(() => strip(el))
    observer.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['role'] })
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => {
    observer?.disconnect()
    root?.removeEventListener('keydown', onKeydown)
  })
}
