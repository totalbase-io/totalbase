/**
 * A grid's column moved by dragging its header (DataViews.md §5.2), as spreadsheets and data grids do: pressed and
 * moved past a few pixels it is a drag - a copy of its title follows the pointer, a primary line marks where it
 * lands, the table scrolls near its sides, Esc cancels - and released where it is, a click (its header's menu
 * opens on click, as ever; the click a drag ends with is swallowed).
 * With a mouse or a trackpad only (the caller decides). Where it lands is the viewer's column order
 * (`placeColumn`, their columnPrefs), so it is kept like the Columns menu's.
 */
const THRESHOLD = 5
/** Near the table's side, it scrolls - this close, this fast per frame. */
const EDGE = 48
const SCROLL_STEP = 12

export function useGridColumnDrag(options: {
  /** The table's scroll container (UTable's root). */
  root: () => HTMLElement | null
  /** The shown columns, in order - where a column may land. */
  keys: () => string[]
  /** Column `key` lands before `before` (a shown column), or after the last one (null). */
  place: (key: string, before: string | null) => void
}) {
  function headerOf(root: HTMLElement, key: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-col-box="${CSS.escape(key)}"]`)?.closest('th') ?? null
  }

  /** Pointer down on column `key`'s header: a drag once it moves; else nothing - its click opens its menu. */
  function start(key: string, event: PointerEvent) {
    const root = options.root()
    const header = root ? headerOf(root, key) : null
    if (!root || !header) return
    const startX = event.clientX
    const startY = event.clientY
    let x = startX
    let dragging = false
    let before: string | null | undefined
    let frame = 0
    let ghost: HTMLElement | null = null
    let line: HTMLElement | null = null

    /** Where the pointer drops it: before the first column whose middle is right of it, else after the last. */
    function target(): { before: string | null, left: number } | null {
      const headers = options.keys().map(k => ({ key: k, th: headerOf(root!, k) })).filter((h): h is { key: string, th: HTMLElement } => h.th !== null)
      for (const h of headers) {
        const rect = h.th.getBoundingClientRect()
        if (x < rect.left + rect.width / 2) return { before: h.key, left: rect.left }
      }
      const last = headers.at(-1)
      return last ? { before: null, left: last.th.getBoundingClientRect().right } : null
    }
    function update() {
      const found = target()
      if (!found || !line) return
      before = found.before
      const rect = root!.getBoundingClientRect()
      line.style.left = `${Math.min(rect.right, Math.max(rect.left, found.left)) - 1}px`
      line.style.top = `${rect.top}px`
      line.style.height = `${rect.height}px`
    }
    function tick() {
      const rect = root!.getBoundingClientRect()
      if (x < rect.left + EDGE) root!.scrollLeft -= SCROLL_STEP
      else if (x > rect.right - EDGE) root!.scrollLeft += SCROLL_STEP
      update()
      frame = requestAnimationFrame(tick)
    }
    function begin() {
      dragging = true
      ghost = document.createElement('div')
      ghost.className = 'pointer-events-none fixed top-0 left-0 z-[100] max-w-60 truncate rounded-md border border-default bg-default px-2 py-1 text-xs font-semibold text-highlighted shadow-lg'
      ghost.textContent = header!.innerText.trim()
      line = document.createElement('div')
      line.className = 'pointer-events-none fixed z-[100] w-0.5 bg-primary'
      document.body.append(ghost, line)
      document.body.style.cursor = 'grabbing'
      header!.style.opacity = '0.5'
      frame = requestAnimationFrame(tick)
    }
    function onMove(move: PointerEvent) {
      x = move.clientX
      if (!dragging) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < THRESHOLD) return
        begin()
      }
      ghost!.style.transform = `translate(${move.clientX + 12}px, ${move.clientY + 12}px)`
    }
    function end(drop: boolean) {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
      cancelAnimationFrame(frame)
      ghost?.remove()
      line?.remove()
      document.body.style.removeProperty('cursor')
      header!.style.removeProperty('opacity')
      if (!dragging) return
      // The click the release makes would open the header's menu: not after a drag.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation()
        click.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      if (drop && before !== undefined) options.place(key, before)
    }
    const onUp = () => end(true)
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return
      key.preventDefault()
      key.stopPropagation()
      end(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  return { start }
}
