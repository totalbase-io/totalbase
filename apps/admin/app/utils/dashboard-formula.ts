/**
 * A dashboard's formulas (Specification_Dashboards.md §5.11, D3): the pages'
 * formula language (utils/formula-engine.ts) over a dashboard's own light
 * context - no page runtime, no Code, no record, no controls:
 *
 * - `{{vars.<name>}}` a variable's value, `{{vars.<name>.label}}` what the
 *   viewer reads for it (an option's label, a preset's name), a custom
 *   range's `.from` / `.to`;
 * - `{{user.<field>}}` the viewer (none in an embed);
 * - `{{row.<column>}}` the widget query's first row, `{{rows}}` every row.
 *
 * As utils/widget-formula.ts does for a page, each dotted token is read here
 * and handed to the engine as a plain value - the engine itself evaluates no
 * property access. `row` is also the name D6's click gives the clicked row.
 */
import { DASHBOARD_FRAME_URL_TOKEN } from '@totalbase/tb-catalog'
import { evaluateFormula, type FormulaReturnType } from '~/utils/formula-engine'
import { resolveFrameUrlTemplate } from '~/utils/frame-url'
import type { DashboardVariable } from '~/types/dashboard'
import { effectiveVariableValue, isCustomRange } from '~/utils/dashboard-variables'

/** One variable as a formula reads it. */
export interface DashboardFormulaVariable {
  value: unknown
  label: string
  from?: string
  to?: string
}

export interface DashboardFormulaScope {
  vars: Record<string, DashboardFormulaVariable>
  user: Record<string, unknown> | null
  /** The query's first row - null without a query, or with no rows. */
  row: Record<string, unknown> | null
  rows: Record<string, unknown>[]
}

const TOKEN = /\{\{\s*(vars|user|row|rows)((?:\.[A-Za-z_]\w*)*)\s*\}\}/g

function read(scope: DashboardFormulaScope, root: string, path: string[]): unknown {
  let value: unknown = root === 'vars' ? scope.vars : root === 'user' ? scope.user : root === 'row' ? scope.row : scope.rows
  for (const [index, key] of path.entries()) {
    if (value === null || typeof value !== 'object') return null
    value = (value as Record<string, unknown>)[key]
    // `{{vars.x}}` alone is its value - its label, its range's bounds by name.
    if (root === 'vars' && index === 0 && path.length === 1) value = (value as DashboardFormulaVariable | undefined)?.value
  }
  return value ?? null
}

/** The formula's result as `returnType`, or `undefined` when it doesn't evaluate. */
export function evaluateDashboardFormula(formula: string, scope: DashboardFormulaScope, returnType?: FormulaReturnType): unknown {
  const values: Record<string, unknown> = {}
  let index = 0
  const source = formula.replace(TOKEN, (_, root: string, path: string) => {
    const key = `__scoped${index++}`
    values[key] = read(scope, root, path ? path.slice(1).split('.') : [])
    return `{{${key}}}`
  })
  const result = evaluateFormula(source, { values, returnType })
  return result.ok ? result.value : undefined
}

/** A dashboard Frame's URL, its `{{vars|user|row.…}}` tokens filled and encoded - null while one is missing. */
export function resolveDashboardFrameUrl(template: string | null | undefined, scope: DashboardFormulaScope): string | null {
  return resolveFrameUrlTemplate(template, token => evaluateDashboardFormula(token, scope), DASHBOARD_FRAME_URL_TOKEN)
}

/**
 * Each variable as formulas read it: its current value (set, else its default) and its label - the option's text the
 * bar shows (`labels`, from DashboardVariablesBar), else the value as text; a custom range's bounds.
 */
export function dashboardFormulaVars(variables: readonly DashboardVariable[], values: Record<string, unknown>, labels: Record<string, string>): Record<string, DashboardFormulaVariable> {
  return Object.fromEntries(variables.map((variable) => {
    const value = effectiveVariableValue(variable, values)
    const fallback = Array.isArray(value) ? value.join(', ') : isCustomRange(value) ? `${value.from} – ${value.to}` : value === null || value === undefined ? '' : String(value)
    const entry: DashboardFormulaVariable = { value, label: labels[variable.name] ?? fallback }
    if (isCustomRange(value)) Object.assign(entry, { from: value.from, to: value.to })
    return [variable.name, entry]
  }))
}
