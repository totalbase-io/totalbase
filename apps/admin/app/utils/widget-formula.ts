/**
 * A widget prop's formula binding (DataViews.md §9.2, §10):
 * the Bind modal's formula language over `{{vars.<name>.<property>}}`,
 * `{{slot.<prop>.<field>}}` and `{{controls.<name>.<state>}}` - another widget's
 * state (its value, an option list's item, a Table's row). The formula engine resolves one-hop tokens
 * only (`{{customer.name}}`) and evaluates no property access of its own, so
 * each dotted token is read here first and handed in as a plain value -
 * the formula itself stays the same restricted language as everywhere else.
 */
import { evaluateFormula, type FormulaReturnType } from '~/utils/formula-engine'
import type { WidgetProp } from '@totalbase/tb-catalog'

export interface FormulaScope {
  /** The page's variables - handles with `value` (a Value) or `data` (a Resource or Call). */
  vars: Record<string, unknown>
  /** The props of the slot the widget lives in (`{ item, index }` inside a Tabs item). */
  slot?: Record<string, unknown>
  /** A row the formula's plain tokens read (`{{saldo}}`) - an option's, for a formula evaluated once per option. */
  row?: Record<string, unknown>
  /** The page's named widgets - their state (`value`, `item`, `row`), as `{{controls.<name>.*}}`. */
  controls?: Record<string, unknown>
}

/** `{{vars.cliente.data.razon_social}}`, `{{slot.item.label}}`, `{{controls.selectCliente.item.cuit}}` - a root, a name and any path. */
const SCOPED_TOKEN = /\{\{\s*(vars|slot|controls)\.([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)\s*\}\}/g

type Root = 'vars' | 'slot' | 'controls'

function read(scope: FormulaScope, root: Root, name: string, path: string[]): unknown {
  let value: unknown = root === 'vars' ? scope.vars[name] : root === 'slot' ? scope.slot?.[name] : scope.controls?.[name]
  // `{{vars.x}}` alone reads what the variable holds - a Value's value, a Resource's or Call's data; `{{controls.x}}` its value.
  if (root !== 'slot' && path.length === 0 && value !== null && typeof value === 'object') {
    const handle = value as Record<string, unknown>
    value = 'value' in handle ? handle.value : handle.data
  }
  for (const key of path) {
    if (value === null || typeof value !== 'object') return null
    value = (value as Record<string, unknown>)[key]
  }
  return value ?? null
}

/** The formula's result as `returnType`, or `undefined` when it doesn't evaluate. */
export function evaluateWidgetFormula(formula: string, scope: FormulaScope, returnType?: FormulaReturnType): unknown {
  const values: Record<string, unknown> = { ...scope.row }
  let index = 0
  const source = formula.replace(SCOPED_TOKEN, (_, root: Root, name: string, path: string) => {
    const key = `__scoped${index++}`
    values[key] = read(scope, root, name, path ? path.slice(1).split('.') : [])
    return `{{${key}}}`
  })
  const result = evaluateFormula(source, { values, returnType })
  return result.ok ? result.value : undefined
}

/** What a prop's formula must produce, from how the inspector edits it. */
export function formulaReturnType(prop: WidgetProp): FormulaReturnType {
  if (prop.editor === 'boolean') return 'boolean'
  if (prop.editor === 'number') return 'number'
  return 'string'
}
