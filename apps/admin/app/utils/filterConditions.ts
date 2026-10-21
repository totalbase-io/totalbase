import { BETWEEN_OPERATOR, betweenJoinLabel, SHORT_OPERATOR_LABELS, TEXT_MATCH_LABELS, UNARY_OPERATORS, unwrapLikeValue, type ComparisonOperator } from '~/utils/filterOperators'

/** One `{field: {operator: value}}` leaf of the filter grammar, in a shape a UI can build from field/operator/value pickers rather than raw JSON. */
export interface Condition {
  field: string
  operator: ComparisonOperator
  /** undefined for a unary operator (_null/_nnull); a [from, to] pair for _between; a plain string otherwise (comma-separated for _in/_nin, same as the raw grammar). */
  value: string | [string, string] | undefined
}

function toEntry(condition: Condition): Record<string, Record<string, unknown>> {
  const value = condition.operator === BETWEEN_OPERATOR
    ? (condition.value as [string, string]).join(',')
    : UNARY_OPERATORS.has(condition.operator)
      ? true // ignored by the parser for a unary operator - see @totalbase/query-engine's parseComparisons, kept only for valid JSON shape
      : condition.value
  return { [condition.field]: { [condition.operator]: value } }
}

/**
 * One condition broken into its three display parts (field/operator/
 * value), each already humanized: a plain-language operator (`equals`,
 * `contains`, `starts with`, ...) with no symbol or explanation, and -
 * for `_like`/`_ilike` - the value with its wrapping `%` wildcards
 * stripped back off (see unwrapLikeValue's own doc). Shared by
 * WhereField.vue's Simple-mode table and formatCondition() below, so a
 * condition reads the same way everywhere it's summarized.
 */
export function humanizeCondition(condition: Condition): { field: string, operatorLabel: string, value: string } {
  if (condition.value === undefined) {
    return { field: condition.field, operatorLabel: SHORT_OPERATOR_LABELS[condition.operator], value: '' }
  }
  if ((condition.operator === '_like' || condition.operator === '_ilike') && typeof condition.value === 'string') {
    const unwrapped = unwrapLikeValue(condition.value)
    return {
      field: condition.field,
      operatorLabel: unwrapped.kind === 'plain' ? SHORT_OPERATOR_LABELS[condition.operator] : TEXT_MATCH_LABELS[unwrapped.kind],
      value: unwrapped.value
    }
  }
  const value = Array.isArray(condition.value) ? condition.value.join(` ${betweenJoinLabel()} `) : condition.value
  return { field: condition.field, operatorLabel: SHORT_OPERATOR_LABELS[condition.operator], value }
}

/** One condition as a human-readable string (`"field contains value"`) - shared by WhereField.vue's own Advanced-mode chips and DataViewGrid.vue's "active filters" badge row above the grid, so both read the same grammar the same way. Built on humanizeCondition() above, so it's the same wording as the Simple-mode table, just joined into one line. */
export function formatCondition(condition: Condition): string {
  const { field, operatorLabel, value } = humanizeCondition(condition)
  return value ? `${field} ${operatorLabel} ${value}` : `${field} ${operatorLabel}`
}

/** How multiple conditions in a builder-produced group combine - one operator for the WHOLE group (mixing AND/OR per-pair without nested groups is ambiguous, so Simple mode offers only this, not per-condition logic). */
export type ConditionJoin = 'and' | 'or'

/** Builder -> JSON. Empty input serializes to '' (no restriction), one condition to a flat `{field: {op: value}}` (join is irrelevant with only one leaf), more than one to an explicit `{"_and": [...]}`/`{"_or": [...]}` array per `join` - chosen over always wrapping in _and. */
export function serializeConditions(conditions: Condition[], join: ConditionJoin = 'and'): string {
  if (conditions.length === 0) return ''
  if (conditions.length === 1) return JSON.stringify(toEntry(conditions[0]!), null, 2)
  return JSON.stringify({ [join === 'or' ? '_or' : '_and']: conditions.map(toEntry) }, null, 2)
}

function parseLeaf(entry: unknown): Condition | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const fieldKeys = Object.keys(entry as Record<string, unknown>)
  if (fieldKeys.length !== 1) return null
  const field = fieldKeys[0]!
  const opValue = (entry as Record<string, unknown>)[field]
  if (opValue === null || typeof opValue !== 'object' || Array.isArray(opValue)) return null
  const opKeys = Object.keys(opValue as Record<string, unknown>)
  if (opKeys.length !== 1) return null
  const operator = opKeys[0] as ComparisonOperator
  const raw = (opValue as Record<string, unknown>)[operator]

  if (UNARY_OPERATORS.has(operator)) return { field, operator, value: undefined }
  const text = leafText(raw)
  if (text === null) return null
  if (operator === BETWEEN_OPERATOR) {
    const parts = text.split(',')
    if (parts.length !== 2) return null
    return { field, operator, value: [parts[0]!.trim(), parts[1]!.trim()] }
  }
  return { field, operator, value: text }
}

/**
 * A stored value as the builder's text: the grammar also takes a JSON number, boolean or - for
 * `_in`/`_nin`/`_between` - a list (`Data_API.md` §3). A list whose items hold a
 * comma can't be one comma-separated text, so it stays in the JSON editor (null).
 */
function leafText(raw: unknown): string | null {
  const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  if (scalar(raw)) return String(raw)
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(scalar)) return null
  const items = raw.map(String)
  return items.some(item => item.includes(',')) ? null : items.join(',')
}

export interface ConditionGroup {
  join: ConditionJoin
  conditions: Condition[]
}

/**
 * JSON -> builder, best-effort. Only recognizes the three shapes
 * serializeConditions() itself produces (a flat multi-key object, always
 * `join: 'and'`; or one `{"_and": [...]}`/`{"_or": [...]}` of single-field
 * leaves) - anything else (a `_not`, a nested `_and`/`_or`, a field
 * repeated with two different operators written by hand, ...) returns
 * null, meaning "too complex to show as chips", not "empty". WhereField.vue
 * reads that as an instruction to disable the builder rather than
 * silently discarding what's there.
 */
export function parseConditions(text: string): ConditionGroup | null {
  const trimmed = text.trim()
  if (!trimmed) return { join: 'and', conditions: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) return { join: 'and', conditions: [] }

  if (entries.length === 1 && (entries[0]![0] === '_and' || entries[0]![0] === '_or')) {
    const join: ConditionJoin = entries[0]![0] === '_or' ? 'or' : 'and'
    const items = entries[0]![1]
    if (!Array.isArray(items)) return null
    const conditions: Condition[] = []
    for (const item of items) {
      const condition = parseLeaf(item)
      if (!condition) return null
      conditions.push(condition)
    }
    return { join, conditions }
  }

  if (entries.some(([key]) => key === '_and' || key === '_or' || key === '_not')) return null

  const conditions: Condition[] = []
  for (const [field, opValue] of entries) {
    const condition = parseLeaf({ [field]: opValue })
    if (!condition) return null
    conditions.push(condition)
  }
  return { join: 'and', conditions }
}
