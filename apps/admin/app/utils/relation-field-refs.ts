import type { DataViewField } from '~/types/dataview'
import { parseRelationFieldRefs, relationFieldKey, type RelationFieldRef } from '~/utils/formula-engine'

/**
 * Same exact string shape as build-dataview-columns.ts's own
 * `displayFieldAlias` (query-engine's `fields=a.b` -> row key `"a.b"`
 * convention) - reimplemented here rather than imported, to avoid that
 * file importing THIS one back (`computedValueResolver` below needs
 * `collectRelationFieldRefs`) turning into a circular module dependency
 * over a one-line string join. Both must stay byte-for-byte identical;
 * they're the same convention, just two call sites.
 */
function relationFieldAlias(column: string, relatedColumn: string): string {
  return `${column}.${relatedColumn}`
}

/**
 * Every one-hop relation reference (`{{fk.related}}`) any of this
 * DataView's grid columns' `config.bindings` formulas make (text/boolean/
 * value - field-config.ts's `BindableKey`), PLUS whatever extra formula
 * strings the caller passes explicitly. The "extra" list exists because
 * CARD/MAP/KANBAN layout formulas (title/description/image, MAP's
 * icon/color) live in `view_config`, not on any one field's own `config` -
 * a caller rendering one of those layouts has to hand its formulas in by
 * hand; everything already on `fields` itself is picked up automatically.
 *
 * Deduped by `column.relatedColumn` - the caller then requests each ONE
 * time as a `fields=column.relatedColumn` join, regardless of how many
 * different formulas reference the exact same related column (the
 * underlying join itself is ALSO deduped server-side, by relation
 * prefix - packages/query-engine's own `JoinRegistry` - so two formulas
 * pulling different columns off the SAME relation still cost one join
 * total, not two).
 */
export function collectRelationFieldRefs(fields: DataViewField[], extraFormulas: (string | null | undefined)[] = []): RelationFieldRef[] {
  const seen = new Map<string, RelationFieldRef>()
  function add(source: unknown) {
    if (typeof source !== 'string' || !source) return
    for (const ref of parseRelationFieldRefs(source)) {
      seen.set(relationFieldAlias(ref.column, ref.relatedColumn), ref)
    }
  }
  for (const field of fields) {
    // A grid's columns - not its record page's widgets, whose bindings are objects ({ kind: 'variable' }), not formulas.
    if (field.kind === 'WIDGET') continue
    const bindings = (field.config as { bindings?: Record<string, string> } | undefined)?.bindings
    if (bindings) for (const formula of Object.values(bindings)) add(formula)
  }
  for (const formula of extraFormulas) add(formula)
  return [...seen.values()]
}

/**
 * Populates `values` with every relation ref's own joined value, read
 * off `row` under its dotted alias (`displayFieldAlias` - the query
 * engine's own `fields=a.b` -> row key `"a.b"` convention, already
 * requested via `collectRelationFieldRefs`'s own result) and stored
 * under the formula engine's own mangled lookup key (`relationFieldKey`)
 * - the one step every caller that builds a formula's `values` from a
 * fetched row has to do, so `{{fk.related}}` actually resolves. Mutates
 * and returns the same object for convenient chaining alongside however
 * the caller already builds `values` from the rest of the row.
 */
export function applyRelationFieldValues(values: Record<string, unknown>, refs: RelationFieldRef[], row: Record<string, unknown>): Record<string, unknown> {
  for (const ref of refs) {
    values[relationFieldKey(ref.column, ref.relatedColumn)] = row[relationFieldAlias(ref.column, ref.relatedColumn)]
  }
  return values
}

/** The `fields=` request param's own entries for a set of relation refs - literally the same dotted alias string both requests the join AND reads it back under, per query-engine's own convention (see this file's other two exports' doc comments). */
export function relationFieldsParamEntries(refs: RelationFieldRef[]): string[] {
  return refs.map(ref => relationFieldAlias(ref.column, ref.relatedColumn))
}

/**
 * The `fields=` request param a DataView's rows are read with - always
 * sent: the DataView's columns (shown or hidden - Specification_DataViews.md §4.1:
 * a column in the DataView is always read, one not in it
 * never is), the primary key (edit/delete addressing), every relation
 * ref's alias and any other join alias the caller has (a foreign key's
 * `display_field`). Never security - the server already dropped the
 * columns this viewer may not read before the grid got them.
 */
export function buildFieldsParam(fields: DataViewField[], primaryKey: string | undefined, refs: RelationFieldRef[], extraAliases: string[] = []): string {
  // A related column (RELATED) is asked for by its path - `brand.country`, one join.
  const names = new Set(fields.filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.columnName).map(f => f.columnName!))
  if (primaryKey) names.add(primaryKey)
  // One list: a related column shown (`brand.name`) is often what a foreign key shows too - asked for once,
  // never twice (the Data API refuses a duplicate output alias).
  return [...new Set([...names, ...relationFieldsParamEntries(refs), ...extraAliases])].join(',')
}
