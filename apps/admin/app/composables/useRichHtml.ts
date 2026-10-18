import type { FormulaRichSegment } from '~/utils/formula-engine'
import { renderRichTextHtml } from '~/utils/rich-text-render'

/** An item whose title/description may carry a formula's FORMAT result (a card, a pin, an event, a bar). */
export interface RichTextItem {
  key: string
  titleRich?: FormulaRichSegment[]
  descriptionRich?: FormulaRichSegment[]
}

export type RichHtmlByKey = Record<string, { title?: string, description?: string }>

/**
 * The rich title/description of every item, as safe HTML keyed by the
 * item's key - rebuilt wholesale whenever the items change (they are
 * capped by the layout's own limit, so this never runs unbounded) and when
 * the theme toggles (badge/color shades differ per theme). An item with
 * neither rich text never enters the map: the view falls back to its plain
 * text. Rendering is async (an ICON() fetches its glyph), so only the latest
 * render lands - a slow earlier one can't overwrite it.
 */
export function useRichHtml(items: () => RichTextItem[]) {
  const colorMode = useColorMode()
  const latest = useLatest()
  const richHtml = ref<RichHtmlByKey>({})
  async function render() {
    const load = latest.next()
    const mode = colorMode.value === 'dark' ? 'dark' : 'light'
    const next: RichHtmlByKey = {}
    for (const item of items()) {
      if (!item.titleRich && !item.descriptionRich) continue
      next[item.key] = {
        title: item.titleRich ? await renderRichTextHtml(item.titleRich, mode) : undefined,
        description: item.descriptionRich ? await renderRichTextHtml(item.descriptionRich, mode) : undefined
      }
    }
    if (!load.isCurrent()) return
    richHtml.value = next
  }
  watch(items, render, { immediate: true, deep: true })
  watch(colorMode, () => render())
  return richHtml
}
