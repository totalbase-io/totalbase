/**
 * The App menu's search box (Security.md §8.2): finds a screen of the menu the viewer may open - by an
 * entry's menu label, its full name, its description (the tooltip) or its group's name, ignoring case and accents. A
 * group that matches keeps all its entries. Only the menu the server already filtered for the viewer is searched.
 */
import type { MenuNode } from '~/types/app-menu'

/** Past this many entries the viewer sees, an AUTO menu offers its search box. */
export const MENU_SEARCH_THRESHOLD = 15

/** A text as searched: lower case, accents off - one character for one, so a match maps back onto the text. */
export function foldText(text: string): string {
  return [...text].map(c => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()[0] ?? c).join('')
}

/** How many entries (DataViews, dashboards) a menu holds, in every group. */
export function countEntries(nodes: readonly MenuNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.kind === 'GROUP' ? countEntries(node.children) : 1), 0)
}

/** The menu with only what matches `term` - entries by their label, name or description; a matching group whole. Empty groups go. */
export function filterMenu(nodes: readonly MenuNode[], term: string): MenuNode[] {
  const q = foldText(term.trim())
  if (!q) return [...nodes]
  const hit = (...texts: (string | null | undefined)[]) => texts.some(text => !!text && foldText(text).includes(q))
  return nodes.flatMap((node): MenuNode[] => {
    if (node.kind === 'GROUP') {
      if (hit(node.name)) return [node]
      const children = filterMenu(node.children, term)
      return children.length ? [{ ...node, children }] : []
    }
    return hit(node.menuLabel, node.name, node.description) ? [node] : []
  })
}

/** A text cut where `term` matches it (case and accents ignored) - the parts to highlight marked. */
export function highlightParts(text: string, term: string): { text: string, match: boolean }[] {
  const q = foldText(term.trim())
  if (!q) return [{ text, match: false }]
  const folded = foldText(text)
  const parts: { text: string, match: boolean }[] = []
  let from = 0
  for (let at = folded.indexOf(q); at !== -1; at = folded.indexOf(q, at + q.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false })
    parts.push({ text: text.slice(at, at + q.length), match: true })
    from = at + q.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false })
  return parts
}
