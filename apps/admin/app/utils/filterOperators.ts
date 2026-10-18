// Mirrors @totalbase/query-engine's operators.ts (server-only, no import
// path into this app) - same reasoning as ACTIONS_BY_RESOURCE_TYPE
// elsewhere: the admin needs to know this shape to build a UI, the
// server package can't be imported here. This backs the Row filter/
// Payload check "condition builder" - FilterConditionBuilder.vue picks
// an operator from here based
// on the selected column's Postgres type, WhereField.vue serializes the
// result into the same {field: {operator: value}} grammar.

export const COMPARISON_OPERATORS = [
  '_eq', '_neq', '_gt', '_gte', '_lt', '_lte',
  '_like', '_ilike', '_regex',
  '_in', '_nin', '_between',
  '_null', '_nnull',
  '_contains', '_contained_by', '_overlap'
] as const
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number]

/** No value - a bare `true` placeholder is stored as the JSON value (see WhereField.vue's serializer); the parser ignores it either way. */
export const UNARY_OPERATORS: ReadonlySet<ComparisonOperator> = new Set(['_null', '_nnull'])
/** Comma-joined into one string value, per parseValue()'s `_between` handling. */
export const BETWEEN_OPERATOR = '_between' as const
/** Comma-joined into one string value, per parseValue()'s `_in`/`_nin` handling - kept as a single free-text input in v1 rather than a multi-value chip picker. */
export const LIST_OPERATORS: ReadonlySet<ComparisonOperator> = new Set(['_in', '_nin'])

/**
 * A label in the UI's language (Specification_Admin_UI.md §14), read when it
 * is shown - the maps below keep their English as the fallback (outside a
 * Nuxt app, or a language without the key), so their callers read them as
 * plain records.
 */
function translatedLabel(key: string, english: string): string {
  try {
    const i18n = useNuxtApp().$i18n
    return i18n.te(key) ? i18n.t(key) : english
  } catch {
    return english
  }
}

/** `english`'s keys as getters translated through `database.filterOperators.<prefix><key>`. */
function translatedLabels<K extends string>(prefix: string, english: Record<K, string>): Record<K, string> {
  const labels = {} as Record<K, string>
  for (const key of Object.keys(english) as K[]) {
    Object.defineProperty(labels, key, { enumerable: true, get: () => translatedLabel(`database.filterOperators.${prefix}${key}`, english[key]) })
  }
  return labels
}

/** The word joining a `_between` pair in a condition summary ("between 1 and 5"). */
export function betweenJoinLabel(): string {
  return translatedLabel('database.filterOperators.betweenJoin', 'and')
}

export const OPERATOR_LABELS: Record<ComparisonOperator, string> = translatedLabels('', {
  _eq: '= equals',
  _neq: '≠ not equals',
  _gt: '> greater than',
  _gte: '≥ greater or equal',
  _lt: '< less than',
  _lte: '≤ less or equal',
  _like: 'LIKE (case-sensitive, % wildcard)',
  _ilike: 'ILIKE (case-insensitive, % wildcard)',
  _regex: '~ regex match',
  _in: 'IN (any of - comma-separated)',
  _nin: 'NOT IN (none of - comma-separated)',
  _between: 'BETWEEN (two comma-separated values)',
  _null: 'IS NULL',
  _nnull: 'IS NOT NULL',
  _contains: '@> contains',
  _contained_by: '<@ contained by',
  _overlap: '&& overlaps'
})

/**
 * Same operators as OPERATOR_LABELS, just the bare human word/phrase with
 * no operator symbol and no parenthetical explanation (a
 * condition summary - WhereField.vue's Simple-mode table, formatCondition()
 * below - should read as plain language, not restate how the operator
 * works). `_like`/`_ilike` read as "contains"/"starts with"/"ends with"/
 * "equals" instead once unwrapLikeValue() below has looked at the actual
 * value, so this fallback ('like') only ever shows for a value with no
 * recognizable wildcard shape (typically hand-written in Advanced mode).
 */
export const SHORT_OPERATOR_LABELS: Record<ComparisonOperator, string> = translatedLabels('short.', {
  _eq: 'equals',
  _neq: 'not equals',
  _gt: 'greater than',
  _gte: 'greater or equal',
  _lt: 'less than',
  _lte: 'less or equal',
  _like: 'like',
  _ilike: 'like',
  _regex: 'matches regex',
  _in: 'in',
  _nin: 'not in',
  _between: 'between',
  _null: 'is null',
  _nnull: 'is not null',
  _contains: 'contains',
  _contained_by: 'contained by',
  _overlap: 'overlaps'
})

/** Coarse client-side classification of a Postgres `format_type()` string (CatalogColumn.dataType) - just enough to pick a sane operator set and value widget, not a full type system. */
export type FieldKind = 'boolean' | 'number' | 'date' | 'datetime' | 'uuid' | 'text' | 'json' | 'array' | 'unknown'

export function classifyDataType(dataType: string): FieldKind {
  const type = dataType.toLowerCase()
  if (type.endsWith('[]')) return 'array'
  if (type.startsWith('bool')) return 'boolean'
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision|money|int2|int4|int8|float4|float8|serial)/.test(type)) return 'number'
  if (type.startsWith('timestamp')) return 'datetime'
  if (type === 'date') return 'date'
  if (type === 'uuid') return 'uuid'
  if (type.startsWith('json')) return 'json'
  if (/^(character varying|character|text|citext)/.test(type)) return 'text'
  return 'unknown'
}

const ORDERABLE_SCALAR: ComparisonOperator[] = ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_between', '_in', '_nin', '_null', '_nnull']

export const OPERATORS_BY_KIND: Record<FieldKind, ComparisonOperator[]> = {
  boolean: ['_eq', '_neq', '_null', '_nnull'],
  number: ORDERABLE_SCALAR,
  date: ORDERABLE_SCALAR,
  datetime: ORDERABLE_SCALAR,
  uuid: ['_eq', '_neq', '_in', '_nin', '_null', '_nnull'],
  // _like/_ilike deliberately excluded from the builder (though still
  // valid, hand-writable JSON the Advanced editor/formatCondition() both
  // still understand fine) - redundant now that
  // TEXT_MATCH_OPERATORS below covers those cases with friendlier
  // labels, both mapping to _ilike (case-insensitive) under the hood.
  text: ['_eq', '_neq', '_regex', '_in', '_nin', '_null', '_nnull'],
  json: ['_contains', '_contained_by', '_null', '_nnull'],
  array: ['_contains', '_contained_by', '_overlap', '_null', '_nnull'],
  unknown: ['_eq', '_neq', '_in', '_nin', '_null', '_nnull']
}

/** Kinds where picking a $-variable (see roles/[id].vue's Variables tab) instead of a literal is common enough to offer directly in the builder. */
export const VARIABLE_CAPABLE_KINDS: ReadonlySet<FieldKind> = new Set(['uuid', 'date', 'datetime'])

/**
 * UI-only "friendly" text operators offered alongside the real ones for
 * `kind === 'text'` (writing `%value%` into a raw LIKE by hand isn't
 * discoverable). Not part of ComparisonOperator/the wire grammar at
 * all - FilterConditionBuilder.vue maps a pick here down to a real
 * `_ilike` condition with the value wrapped/escaped before it ever
 * reaches WhereField's serializer, so the JSON on the wire is
 * unchanged and every other consumer of Condition needs no changes.
 */
export const TEXT_MATCH_OPERATORS = ['_starts_with', '_ends_with', '_contains_text'] as const
export type TextMatchOperator = (typeof TEXT_MATCH_OPERATORS)[number]

export const TEXT_MATCH_LABELS: Record<TextMatchOperator, string> = translatedLabels('textMatch.', {
  _starts_with: 'starts with',
  _ends_with: 'ends with',
  _contains_text: 'contains'
})

/** Escapes Postgres LIKE/ILIKE's own special characters (`%`, `_`, and the escape char `\` itself) in a literal value before wrapping it in wildcards - without this, a value containing a literal `%` or `_` would silently act as a wildcard instead of matching itself. */
export function escapeLikeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** Wraps an already-escaped-by-caller-or-not literal in the right wildcards for one TextMatchOperator - the value half of the `_ilike` condition FilterConditionBuilder.vue emits. */
export function wrapLikeValue(operator: TextMatchOperator, raw: string): string {
  const escaped = escapeLikeValue(raw)
  switch (operator) {
    case '_starts_with': return `${escaped}%`
    case '_ends_with': return `%${escaped}`
    case '_contains_text': return `%${escaped}%`
  }
}

/** Reverse of escapeLikeValue() - best-effort, only used for display. */
function unescapeLikeValue(escaped: string): string {
  return escaped.replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\\\/g, '\\')
}

/**
 * Reverse of wrapLikeValue() - given a raw `_like`/`_ilike` value, tells a
 * condition summary (formatCondition() below) how to show it in plain
 * language: "contains"/"starts with"/"ends with" plus the bare literal,
 * instead of the operator's own name and a value still wearing its `%`
 * wildcards (showing `%me%` to someone who never typed a `%`
 * themselves - built entirely by the Simple-mode Builder - just exposes
 * the LIKE grammar they didn't ask to see). Only recognizes the exact
 * shapes wrapLikeValue() itself produces (an outer, unescaped `%` at
 * one or both ends); a value with `%`/`_` wildcards elsewhere in the
 * middle (hand-written in Advanced mode) falls through as `kind:
 * 'plain'` with the value shown exactly as stored - correct, just not
 * specially summarized.
 */
export function unwrapLikeValue(raw: string): { kind: TextMatchOperator | 'plain', value: string } {
  const startsWithWildcard = raw.startsWith('%') && !raw.startsWith('\\%')
  const endsWithWildcard = raw.endsWith('%') && !raw.endsWith('\\%') && !(raw.length >= 2 && raw[raw.length - 2] === '\\')
  if (startsWithWildcard && endsWithWildcard && raw.length >= 2) {
    return { kind: '_contains_text', value: unescapeLikeValue(raw.slice(1, -1)) }
  }
  if (endsWithWildcard) {
    return { kind: '_starts_with', value: unescapeLikeValue(raw.slice(0, -1)) }
  }
  if (startsWithWildcard) {
    return { kind: '_ends_with', value: unescapeLikeValue(raw.slice(1)) }
  }
  return { kind: 'plain', value: unescapeLikeValue(raw) }
}
