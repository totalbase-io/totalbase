import type { ComponentPublicInstance, Ref } from 'vue'

/**
 * A vertical UNavigationMenu's groups (T59, axe aria-allowed-attr): Nuxt UI draws each group's chevron as a second
 * accordion trigger - a `span` carrying `aria-expanded` and `aria-controls`, which a span may not have - inside the
 * group's own trigger, which already says whether it's open. The chevron is decoration: those attributes removed, hidden
 * from assistive technology, kept that way as the menu redraws.
 */
export function useMenuChevronA11y(target: Ref<HTMLElement | ComponentPublicInstance | null>) {
  let observer: MutationObserver | undefined
  const hide = (root: Element) => {
    for (const chevron of root.querySelectorAll('[data-slot="linkTrailing"][aria-expanded], [data-slot="linkTrailing"][aria-controls]')) {
      // A span may not carry them at all - hidden isn't enough for a checker reading the markup (axe aria-allowed-attr).
      chevron.removeAttribute('aria-expanded')
      chevron.removeAttribute('aria-controls')
      if (chevron.getAttribute('aria-hidden') !== 'true') chevron.setAttribute('aria-hidden', 'true')
    }
  }
  watch(target, (value) => {
    observer?.disconnect()
    // A component's `$el` is its first node - a fragment's (UNavigationMenu renders one) is a text or comment node:
    // the element holding it then.
    const node = value instanceof Element ? value : (value as ComponentPublicInstance | null)?.$el as Node | undefined
    const root = node instanceof Element ? node : node?.parentElement
    if (!root) return
    hide(root)
    observer = new MutationObserver(() => hide(root))
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-controls'] })
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => observer?.disconnect())
}
