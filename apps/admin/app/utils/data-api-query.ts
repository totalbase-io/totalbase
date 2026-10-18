/**
 * A Data API query object (QueryBuilder.vue's `QueryObject` - `where` and
 * `having` as the filter grammar, `group_by` as string[][], aggregates as
 * `{ column: alias }` maps) as the GET query parameters the server's parser
 * reads (packages/query-engine/src/parser.ts): `group_by` comma-separated
 * dotted paths, everything nested in bracket form (`where[status][_eq]=…`,
 * `_sum[total]=total`).
 */
import { flattenQueryObject } from '~/utils/flatten-query-object'

export function toDataApiParams(query: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (key === 'group_by' && Array.isArray(value)) {
      const paths = value.map(path => (Array.isArray(path) ? path.join('.') : String(path))).filter(Boolean)
      if (paths.length > 0) params.group_by = paths.join(',')
    } else if (typeof value === 'object') {
      Object.assign(params, flattenQueryObject(value, key))
    } else {
      params[key] = String(value)
    }
  }
  return params
}

const usesVariable = (value: unknown) => JSON.stringify(value ?? null).includes('{{')

/**
 * A filter (`where`, `having`) without the conditions that read a page
 * variable (`{{vars.*}}`) - in the Design form no variable has a value, so
 * a sample run keeps every other condition, as written. A group left empty
 * goes too.
 */
export function withoutVariableConditions(filter: unknown): Record<string, unknown> | undefined {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      const parts = (Array.isArray(value) ? value : []).map(withoutVariableConditions).filter(part => part !== undefined)
      if (parts.length > 0) out[key] = parts
    } else if (key === '_not') {
      const inner = withoutVariableConditions(value)
      if (inner) out[key] = inner
    } else if (!usesVariable(value)) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** A query as the Design form can run it: its filters without their variable conditions, any other part that reads a variable left out. */
export function withoutVariables(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).flatMap(([key, value]) => {
    if (key === 'where' || key === 'having') {
      const filter = withoutVariableConditions(value)
      return filter ? [[key, filter]] : []
    }
    return usesVariable(value) ? [] : [[key, value]]
  }))
}
