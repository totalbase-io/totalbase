/**
 * A Tabs', an Accordion's or a Dropdown menu's items (`WidgetItem`,
 * DataViews.md §9.2) as Nuxt UI takes them.
 * Live, each item's formulas over the page - its label, Disabled, Visible
 * (a hidden one left out) - and a menu item's Code function as its
 * `onSelect`, run with `{ item: { value, label } }`. On the canvas
 * (`run` absent), its literals only: every item drawn, nothing runs.
 */
import type { WidgetItem } from '@totalbase/tb-catalog'
import { evaluateWidgetFormula, type FormulaScope } from '~/utils/widget-formula'

export function resolveWidgetItems(items: readonly unknown[], scope: FormulaScope, run?: (handler: string, event: Record<string, unknown>) => unknown): unknown[] {
  return items.flatMap((raw) => {
    if (raw === null || typeof raw !== 'object') return [raw]
    const { formulas, onSelect, ...item } = raw as WidgetItem & Record<string, unknown>
    if (!run) return [item]
    if (formulas?.visible && evaluateWidgetFormula(formulas.visible, scope, 'boolean') === false) return []
    if (formulas?.label) {
      const label = evaluateWidgetFormula(formulas.label, scope, 'string')
      if (label !== undefined && label !== null) item.label = String(label)
    }
    if (formulas?.disabled) item.disabled = evaluateWidgetFormula(formulas.disabled, scope, 'boolean') === true
    if (!onSelect) return [item]
    return [{ ...item, onSelect: () => run(onSelect, { item: { value: item.value ?? null, label: item.label ?? null } }) }]
  })
}
