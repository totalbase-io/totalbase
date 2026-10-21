import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { DashboardVariable, DateRangeValue } from '~/types/dashboard'

/**
 * `$VAR.*` values <-> the page's URL query (Dashboards.md §3.7:
 * a shared link reproduces the same view). Only values the viewer
 * explicitly set are kept - an absent key means "use the variable's
 * default" (the server applies it); an empty `?status=` means "explicitly
 * cleared" (binds NULL even when a default exists).
 */

const CUSTOM_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/

function first(raw: LocationQuery[string] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value ?? null
}

export function decodeVariableValues(variables: DashboardVariable[], query: LocationQuery): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const variable of variables) {
    if (!(variable.name in query)) continue
    const raw = query[variable.name]
    const text = first(raw)
    if (text === null || text === '') {
      values[variable.name] = null
      continue
    }
    switch (variable.type) {
      case 'DATE_RANGE': {
        const custom = CUSTOM_RANGE.exec(text)
        values[variable.name] = custom ? { from: custom[1], to: custom[2] } : text
        break
      }
      case 'SELECT':
        values[variable.name] = variable.multiple
          ? (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string' && v !== '')
          : text
        break
      case 'NUMBER': {
        const number = Number(text)
        if (Number.isFinite(number)) values[variable.name] = number
        break
      }
      default:
        values[variable.name] = text
    }
  }
  return values
}

export function encodeVariableValues(variables: DashboardVariable[], values: Record<string, unknown>): LocationQueryRaw {
  const query: LocationQueryRaw = {}
  for (const variable of variables) {
    if (!(variable.name in values)) continue
    const value = values[variable.name]
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      query[variable.name] = ''
    } else if (variable.type === 'DATE_RANGE' && typeof value === 'object') {
      const range = value as { from: string, to: string }
      query[variable.name] = `${range.from}..${range.to}`
    } else if (Array.isArray(value)) {
      query[variable.name] = value.map(String)
    } else {
      query[variable.name] = String(value)
    }
  }
  return query
}

/** A variable's default value: resolved by the server for whoever reads it (a user default), else its constant. */
export function variableDefaultValue(variable: DashboardVariable): unknown {
  if (variable.defaultValue !== undefined) return variable.defaultValue
  return variable.default?.source === 'constant' ? variable.default.value : null
}

/** The value a variable currently has: the explicit one if set (even null), else its default. */
export function effectiveVariableValue(variable: DashboardVariable, values: Record<string, unknown>): unknown {
  return variable.name in values ? values[variable.name] : variableDefaultValue(variable)
}

export function isCustomRange(value: unknown): value is Exclude<DateRangeValue, string> {
  return typeof value === 'object' && value !== null && 'from' in value && 'to' in value
}
