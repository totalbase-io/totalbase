import type { MenuNode, MenuObject } from '~/types/app-menu'

export type MenuSortKey = 'NAME' | 'TYPE'
export type MenuSortDirection = 'ASC' | 'DESC'

/**
 * The App menu sorted at every level - the root, each group, each
 * subgroup - by the same key and direction (Security.md
 * §8.2). Groups come first, ordered by name (they have no type); then the
 * entries, by name, or by `typeOf` (the label the editor shows) and name
 * for ties. DESC reverses the whole order. Returns a new tree.
 */
export function sortMenu(
  nodes: MenuNode[],
  key: MenuSortKey,
  direction: MenuSortDirection,
  typeOf: (object: MenuObject) => string,
  locale?: string
): MenuNode[] {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
  const sign = direction === 'ASC' ? 1 : -1
  const compare = (a: MenuNode, b: MenuNode): number => {
    const aGroup = a.kind === 'GROUP'
    const bGroup = b.kind === 'GROUP'
    if (aGroup !== bGroup) return aGroup ? -1 : 1
    if (key === 'TYPE' && a.kind !== 'GROUP' && b.kind !== 'GROUP') {
      const byType = collator.compare(typeOf(a), typeOf(b))
      if (byType !== 0) return sign * byType
    }
    return sign * collator.compare(a.name, b.name)
  }
  const walk = (list: MenuNode[]): MenuNode[] =>
    list
      .map(node => (node.kind === 'GROUP' ? { ...node, children: walk(node.children) } : node))
      .sort(compare)
  return walk(nodes)
}
