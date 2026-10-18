import type { Ref } from 'vue'

/**
 * A sizable widget's *Fill height* (Specification_DataViews.md §12.2):
 * the height its page has left - the frame it scrolls in,
 * minus everything else in it - so the whole page fits on screen, the
 * widget taking the slack (a Detail's rows, an editor). Never below `min`,
 * the widget's own height: a page too tall to fit scrolls as it would.
 *
 * Measured, not a CSS layout: the page is a flow of 12-column rows (a
 * grid), and no single row can be told to take "the rest" of it. Measured
 * again when the frame or its content resizes.
 */
export function useFillHeight(el: Ref<HTMLElement | null>, enabled: Ref<boolean>, min: Ref<number>) {
  const height = ref<number | null>(null)
  let observer: ResizeObserver | null = null
  let frame: HTMLElement | null = null
  let pending = 0

  /**
   * Where the page scrolls - the nearest ancestor that scrolls its content
   * (a page's body, a Splitter's panel). A fixed page body is a frame even
   * when its widgets scroll instead. Not one that only clips it, like a
   * Card: its height follows what it holds, so filling it would only grow it,
   * measure after measure.
   */
  function frameOf(node: HTMLElement): HTMLElement | null {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent.hasAttribute('data-fill-height-frame') && parent.clientHeight > 0) return parent
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.clientHeight > 0) return parent
    }
    return null
  }
  function measure() {
    pending = 0
    if (!el.value || !frame) return
    const style = getComputedStyle(frame)
    const rect = frame.getBoundingClientRect()
    // Where the page's widgets end - not the frame's children, which may stretch to fill it (Fit to screen).
    const areas = areasIn(frame)
    if (areas.length === 0) return
    const contentBottom = Math.max(...areas.map(area => area.getBoundingClientRect().bottom))
    const frameBottom = rect.top + frame.clientTop + frame.clientHeight - Number.parseFloat(style.paddingBottom)
    const current = el.value.getBoundingClientRect().height
    const next = Math.max(min.value, Math.floor(current + frameBottom - contentBottom))
    if (height.value === null || Math.abs(next - height.value) > 1) height.value = next
  }
  /**
   * The frame's widget areas - the outermost ones in it carry its content's
   * height. Outermost within the frame: in a Splitter's panel, the page's own
   * area holds the panel, outside the frame, and doesn't count.
   */
  function areasIn(node: HTMLElement): HTMLElement[] {
    return Array.from(node.querySelectorAll<HTMLElement>('.widget-area')).filter((area) => {
      const outer = area.parentElement?.closest('.widget-area')
      return !outer || !node.contains(outer)
    })
  }
  function schedule() {
    if (!pending) pending = requestAnimationFrame(measure)
  }
  function stop() {
    observer?.disconnect()
    observer = null
    window.removeEventListener('resize', schedule)
    if (pending) cancelAnimationFrame(pending)
    pending = 0
    height.value = null
  }
  watch([el, enabled], ([node, on]) => {
    stop()
    if (!node || !on) return
    frame = frameOf(node)
    if (!frame) return
    observer = new ResizeObserver(schedule)
    observer.observe(frame)
    for (const area of areasIn(frame)) observer.observe(area)
    window.addEventListener('resize', schedule)
    schedule()
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(stop)

  return height
}
