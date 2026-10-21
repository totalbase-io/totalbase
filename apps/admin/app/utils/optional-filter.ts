import type { DashboardVariable } from '~/types/dashboard'

/**
 * The standard SQL for an optional filter over a dashboard variable
 * (Dashboards.md §3.4): the condition holds while the variable
 * is unset (NULL), so the filter applies only once the viewer picks a value.
 * Plain SQL - the server rewrites nothing, and the query runs the same in
 * psql. `column` is written as typed: a name or any expression.
 *
 * A Select or Text variable binds as `text` (`text[]` with several values), so
 * the column is compared as text - a `uuid` or integer column has no `=` or
 * `ILIKE` against text (the same as the suggested widgets, dashboard-suggest.ts).
 */
export function optionalFilterSql(variable: Pick<DashboardVariable, 'name' | 'type' | 'multiple'>, column: string): string {
  const v = `$VAR.${variable.name}`
  const col = column.trim()
  const asText = /^[\w."]+$/.test(col) ? `${col}::text` : `(${col})::text`
  switch (variable.type) {
    case 'DATE_RANGE':
      return `(${v}.from IS NULL OR ${col} >= ${v}.from) AND (${v}.to IS NULL OR ${col} < ${v}.to)`
    case 'SELECT':
      return variable.multiple ? `(${v} IS NULL OR ${asText} = ANY(${v}))` : `(${v} IS NULL OR ${asText} = ${v})`
    case 'TEXT':
      return `(${v} IS NULL OR ${asText} ILIKE '%' || ${v} || '%')`
    case 'NUMBER':
      return `(${v} IS NULL OR ${col} = ${v})`
  }
}
