import { h } from 'vue'
import { UButton } from '#components'

export type SortDirection = false | 'asc' | 'desc'

/**
 * The one sortable column header for every UTable in the admin - Nuxt
 * UI's own documented pattern (Table > Sorting), unstyled beyond it, so
 * each table's header reads the same. `direction` is the column's current
 * sort; clicking calls `onToggle`, which owns what the next sort is
 * (TanStack's own `toggleSorting`, or a server-side sort).
 */
export function sortableHeader(label: string, direction: SortDirection, onToggle: () => void, align: 'left' | 'center' | 'right' = 'left') {
  const icon = direction === 'asc'
    ? 'i-lucide-arrow-up-narrow-wide'
    : direction === 'desc'
      ? 'i-lucide-arrow-down-wide-narrow'
      : 'i-lucide-arrow-up-down'
  // Its direction on the sorted column only; on the others, on hover or focus - arrows on every column were noise.
  // Inside the button, so its hover covers it too; on the title's far side from the cells' edge - after it in a
  // left or centered column, before it in a right-aligned one - so the title lines up with its column's cells.
  const iconClass = direction ? 'text-highlighted' : 'text-muted opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100'
  return h(UButton, {
    color: 'neutral',
    variant: 'ghost',
    size: 'xs',
    label,
    ...(align === 'right' ? { leadingIcon: icon } : { trailingIcon: icon }),
    ui: {
      base: 'group/sort font-semibold text-default hover:text-highlighted',
      ...(align === 'right' ? { leadingIcon: iconClass } : { trailingIcon: iconClass })
    },
    class: align === 'right' ? '-mx-2 ml-auto flex' : align === 'center' ? 'mx-auto flex' : '-mx-2',
    onClick: onToggle
  })
}
