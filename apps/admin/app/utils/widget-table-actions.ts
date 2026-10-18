/** A Table widget's Row actions column - apart from widget-table.ts, which stays plain (no components) for its tests. */
import type { TableColumn } from '@nuxt/ui'
import type { TableAction } from '@totalbase/tb-catalog'
import { h } from 'vue'
import { UButton, UTooltip } from '#components'

/** Whether an action's Disabled or Visible formula holds for a row - `undefined` when it has none (or on the canvas). */
export type ActionFormula = (formula: string, row: Record<string, unknown>) => boolean | undefined

/**
 * Its Row actions: a last column of icon buttons, each in a tooltip of its
 * label. A click is the action's, never the row's (Row clicked); `onClick`
 * is absent on the canvas, where they only show. Live, each action's
 * formulas per row (`check`) turn it off or leave it out on that row.
 */
export function tableActionsColumn<T extends Record<string, unknown>>(actions: readonly TableAction[], onClick?: (action: string, row: T) => void, check?: ActionFormula): TableColumn<T> {
  const holds = (formula: string | undefined, row: T) => (formula && check ? check(formula, row) : undefined)
  return {
    id: '__actions',
    header: '',
    meta: { class: { th: 'w-px', td: 'w-px whitespace-nowrap text-right' } },
    cell: ({ row }) => h('div', { class: 'flex justify-end gap-1' }, actions
      .filter(action => holds(action.formulas?.visible, row.original) !== false)
      .map(action => h(UTooltip, { text: action.label || action.name }, () => h(UButton, {
        'icon': action.icon || 'i-lucide-circle-dot',
        'label': action.icon ? undefined : action.label || action.name,
        'size': 'xs',
        'color': 'neutral',
        'variant': 'ghost',
        'disabled': holds(action.formulas?.disabled, row.original) === true,
        'aria-label': action.label || action.name,
        'onClick': (event: MouseEvent) => {
          event.stopPropagation()
          onClick?.(action.name, row.original)
        }
      }))))
  }
}
