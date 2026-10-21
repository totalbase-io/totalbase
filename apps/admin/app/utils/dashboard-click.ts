/**
 * What a click on a dashboard widget's mark does (Dashboards.md §5.14, D6): its `config.click`
 * resolved against the clicked row and the variables - plain data the card acts on. Values are formulas over
 * `{{row.<column>}}` and `{{vars.<name>}}` (utils/dashboard-formula.ts); a filter's value that comes out empty
 * drops its condition, as a page Resource's does. Targets are ids: the App's routes take a DataView's or a
 * dashboard's id where they take a slug.
 */
import { evaluateDashboardFormula, resolveDashboardFrameUrl, type DashboardFormulaScope } from '~/utils/dashboard-formula'

export type DashboardClickAction
  = | { kind: 'filter', variable: string, value: unknown }
    | { kind: 'route', path: string, query: Record<string, string> }
    | { kind: 'url', href: string, newTab: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A formula's value - a text with no `{{` is a literal (a filter's fixed value). */
function valueOf(formula: unknown, scope: DashboardFormulaScope): unknown {
  if (typeof formula !== 'string') return formula
  return formula.includes('{{') ? evaluateDashboardFormula(formula, scope) : formula
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

/** A filter's value as the grammar's text (the DataView's chips read text). */
function asText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(',') : String(value)
}

/**
 * A filter object (the Data API's where grammar) with its formulas filled - a condition whose value comes out
 * empty is dropped, a group left empty too. Null when nothing is left.
 */
export function resolveClickFilter(filter: unknown, scope: DashboardFormulaScope): Record<string, unknown> | null {
  if (!isRecord(filter)) return null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      const parts = (Array.isArray(value) ? value : []).map(part => resolveClickFilter(part, scope)).filter((p): p is Record<string, unknown> => p !== null)
      if (parts.length) out[key] = parts
    } else if (key === '_not') {
      const inner = resolveClickFilter(value, scope)
      if (inner) out[key] = inner
    } else if (isRecord(value)) {
      const operators: Record<string, unknown> = {}
      for (const [operator, raw] of Object.entries(value)) {
        const resolved = valueOf(raw, scope)
        // A unary operator (_null: true) keeps its value; an empty one drops its condition.
        if (typeof raw === 'boolean') operators[operator] = raw
        else if (!isEmpty(resolved)) operators[operator] = asText(resolved)
      }
      if (Object.keys(operators).length) out[key] = operators
    }
  }
  return Object.keys(out).length ? out : null
}

/** The action a click runs, or null when it has none (or what it needs came out empty). */
export function resolveDashboardClick(click: unknown, scope: DashboardFormulaScope): DashboardClickAction | null {
  if (!isRecord(click)) return null
  switch (click.action) {
    case 'FILTER':
      return typeof click.variable === 'string' ? { kind: 'filter', variable: click.variable, value: valueOf(click.value, scope) ?? null } : null
    case 'DATAVIEW': {
      if (typeof click.dataview !== 'string') return null
      const filter = resolveClickFilter(click.filter, scope)
      return { kind: 'route', path: `/app/dataviews/${encodeURIComponent(click.dataview)}`, query: filter ? { filter: JSON.stringify(filter) } : {} }
    }
    case 'RECORD': {
      const pk = valueOf(click.pk, scope)
      if (typeof click.dataview !== 'string' || isEmpty(pk)) return null
      return { kind: 'route', path: `/app/dataviews/${encodeURIComponent(click.dataview)}`, query: { pk: String(pk) } }
    }
    case 'DASHBOARD': {
      if (typeof click.dashboard !== 'string') return null
      const query: Record<string, string> = {}
      for (const [name, formula] of Object.entries(isRecord(click.variables) ? click.variables : {})) {
        const value = valueOf(formula, scope)
        if (!isEmpty(value)) query[name] = asText(value)
      }
      if (typeof click.tab === 'string' && click.tab) query.tab = click.tab
      return { kind: 'route', path: `/app/dashboards/${encodeURIComponent(click.dashboard)}`, query }
    }
    case 'URL': {
      const href = resolveDashboardFrameUrl(typeof click.url === 'string' ? click.url : null, scope)
      return href ? { kind: 'url', href, newTab: click.newTab === true } : null
    }
    default:
      return null
  }
}
