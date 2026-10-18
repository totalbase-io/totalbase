import type { DashboardVariable } from '~/types/dashboard'

/**
 * The standard SQL for an optional filter over a dashboard variable
 * (Specification_Dashboards.md §3.4): the condition holds while the variable
 * is unset (NULL), so the filter applies only once the viewer picks a value.
 * Plain SQL - the server rewrites nothing, and the query runs the same in
 * psql. `column` is written as typed: a name or any expression.
 */
export function optionalFilterSql(variable: Pick<DashboardVariable, 'name' | 'type' | 'multiple'>, column: string): string {
  const v = `$VAR.${variable.name}`
  const col = column.trim()
  switch (variable.type) {
    case 'DATE_RANGE':
      return `(${v}.from IS NULL OR ${col} >= ${v}.from) AND (${v}.to IS NULL OR ${col} < ${v}.to)`
    case 'SELECT':
      return variable.multiple ? `(${v} IS NULL OR ${col} = ANY(${v}))` : `(${v} IS NULL OR ${col} = ${v})`
    case 'TEXT':
      return `(${v} IS NULL OR ${col} ILIKE '%' || ${v} || '%')`
    case 'NUMBER':
      return `(${v} IS NULL OR ${col} = ${v})`
  }
}
