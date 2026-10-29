/**
 * Bindings v2 - THE formula engine (design closed in chat: one
 * `config.bindings` map replaces the old `textBindings`/`booleanBindings`
 * split). It replaces two older, now-deleted engines: `resolve-
 * template.ts` (plain `{{col}}` substitution, no functions - its last
 * callers, PROGRESS/AVATAR/USER's own config + field.label, now go
 * through this file instead, via field-config.ts's own
 * `evaluateTemplateFormula`/`evaluateTemplateFormulaNumber`) and
 * `condition-eval.ts` (a separate `_eq/_and/_or` boolean tree, never
 * actually reached the point of being wired into any real caller). This
 * file is now the ONLY formula/template engine in the app.
 *
 * Three layers, deliberately kept separate (jsep parses, our evaluator
 * runs, formula.js computes):
 *
 * 1. `jsep` (MIT, actively maintained) parses TEXT into an AST. It has
 *    no idea what anything means - it doesn't even know if `ROUND`
 *    exists. Its own grammar already excludes assignment, `new`,
 *    declared functions, `this` - nothing to defend against there.
 * 2. THIS FILE's `evaluateNode` walks that AST. It is the ONLY place
 *    that decides what actually executes - operators (+ - * / % > < ==
 *    && || ! ternary) are implemented HERE, in plain JS, never handed to
 *    any library. `MemberExpression` (`a.b`, `a["b"]`) has NO case at
 *    all - deliberately unimplemented, not merely disallowed - so
 *    nothing here can ever reach a prototype chain, regardless of what
 *    jsep itself is capable of parsing.
 * 3. `@formulajs/formulajs` (MIT) supplies the BODY of a curated
 *    allowlist of named functions (`ALLOWED_FUNCTION_NAMES` below) - never
 *    imported as a whole namespace into anything a formula can reach;
 *    a function not in that map is simply not callable, no matter how
 *    big the underlying library is.
 *
 * Column references keep the SAME `{{col}}` token the app has always
 * used (originally resolve-template.ts's own plain-substitution token,
 * now this file's - every caller, PROGRESS/BADGE/AVATAR/USER's own
 * config strings included, has since migrated onto this engine and that
 * file is deleted) - stripped to a bare identifier before jsep ever sees
 * the text (`preprocess`). Unlike that old substitution mode, EVERY
 * binding here is a full expression now - there is no more "plain text
 * with a token in it" middle ground; `"Hola, " + {{nombre}}` replaces
 * `"Hola, {{nombre}}"`.
 *
 * Dates/times are boxed to real JS `Date` objects the moment an
 * Identifier resolves to a temporal column (`columnKinds`), and
 * unboxed back to the target's own raw stored shape only once, at the
 * very end (`coerceResult`) - see this file's own `dateArith` doc
 * comment for the exact (Excel-flavored, not byte-for-byte Excel)
 * unit convention chosen for `+`/`-` on a boxed date.
 */
import jsep from 'jsep'
import { shallowRef } from 'vue'
import { addDays, addMinutes, differenceInCalendarDays, format as formatDateFns, isValid as isValidDate, parse as parseDateFns, parseISO } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { ROLE_COLOR_OPTIONS, type RoleColor } from '~/types/permission'
// Reused, not redeclared - format-pattern.ts already owns this exact
// union (its own `displayFormat` engine), and Nuxt auto-imports every
// exported symbol from app/utils/*.ts globally - a second `TemporalKind`
// here would silently shadow that one app-wide (confirmed with `nuxi
// prepare`'s own "Duplicated imports" warning when this really was a
// second declaration - a bug found writing this file).
import { formatNumberValue, uiDateFnsLocale, uiIntlLocale, type TemporalKind } from './format-pattern'
/** What a binding's result gets coerced to - the DESTINATION decides this, never the formula itself. */
export type FormulaReturnType = 'string' | 'number' | 'boolean' | TemporalKind

export type FormulaValue = string | number | boolean | null

export interface FormulaColumnInfo {
  /** `undefined` for a non-temporal column - a plain string/number/boolean value, used as-is. */
  kind?: TemporalKind
}

/**
 * One run (BOLD/ITALIC/etc. below never nest markup - they set flags on
 * whatever plain text/segments they wrap) of the RICH TEXT a formula
 * can build with BOLD/ITALIC/UNDERLINE/STRIKETHROUGH/COLOR/BADGE/LINK/
 * NEW_LINE (this file's own top doc comment update explains why this
 * needed a real return-shape change, not just four more `fx.*`
 * entries). `color`/`badge` are a closed `RoleColor` token, never a raw
 * CSS string - same "closed set, nothing free-form reaches the DOM"
 * discipline the rest of this evaluator already follows (no
 * `MemberExpression`, no raw `eval`); the actual hex/oklch only gets
 * resolved at RENDER time (`rich-text-render.ts`'s own `roleColorShade`
 * call), this file stays UI-agnostic. `link.url` is pre-validated
 * (`validateLinkUrl` below) to an `http(s)/mailto/tel` scheme or a
 * relative path - never `javascript:`/`data:`/anything else - a
 * disallowed URL just never gets attached (LINK degrades to plain,
 * unlinked text, same "never throws" rule the rest of the engine
 * follows). `break` (from `NEW_LINE()`) carries no text of its own -
 * `rich-text-render.ts` renders it as one `<br>`, ignoring every other
 * flag on it. `icon` (from `ICON(name)`, e.g. `ICON("i-lucide-mail")`)
 * is the other icon-only case: a well-formed lucide name (`LUCIDE_ICON_
 * NAME_PATTERN` - the names `IconPickerField` offers have this shape),
 * never a free-form string; `rich-text-render.ts` resolves the
 * actual SVG glyph for it, lazily (that lookup table is ~500KB - only
 * loaded the first time a formula actually uses `ICON()`).
 */
export interface FormulaRichSegment {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  color?: RoleColor
  badge?: RoleColor
  link?: { url: string, target: LinkTarget }
  break?: boolean
  icon?: string
}
export const LINK_TARGETS = ['_self', '_blank', '_parent', '_top'] as const
export type LinkTarget = (typeof LINK_TARGETS)[number]

export interface EvaluateFormulaOptions {
  /** The record's own current field values (raw, DB shape - e.g. a `date` column is `"yyyy-MM-dd"`, `timestamptz` is a UTC ISO string). Keyed by column name, same as the record engine (record-engine.ts)'s own `values`. */
  values: Record<string, unknown>
  /** Which of `values`' keys are temporal, and which kind - drives the box/unbox at the Identifier/result boundary. Columns not listed here are treated as plain (string/number/boolean/null) values. */
  columnKinds?: Record<string, TemporalKind | undefined>
  /** IANA zone (Settings > General `system.timezone`) - only meaningful for a `datetime` column that's ALSO `timestamptz` (tz-aware); a naive timestamp/date/time never needs this, same convention `format-pattern.ts` already established. */
  timezone?: string
  /** What the result gets coerced to before being handed back - the bound property's own expected type (string for label, boolean for visible/disabled, a `TemporalKind` for a `value` binding on a temporal column, 'number' for one on a numeric column). Omit for a plain, uncoerced result (rarely useful - almost every real caller knows its own target type). */
  returnType?: FormulaReturnType
  /**
   * What each foreign key column among `values` shows - its referenced row's presentation
   * (DataViews.md §15.5), keyed by column name. A token naming one is that text wherever
   * the formula makes text (the result, `+` with text, a function's argument), and still the key in a
   * comparison or arithmetic - `{{work_order}} == "..."` compares the key.
   */
  foreignKeyText?: Record<string, string>
}

export type EvaluateFormulaResult
  /**
   * `rich` is set ONLY when the formula actually used a FORMAT function
   * (BOLD/ITALIC/.../NEW_LINE) somewhere - `value` is ALWAYS the plain,
   * flattened text (formatting stripped, `NEW_LINE()` as `"\n"|) either
   * way, so every EXISTING caller (Card/Map title, Visible/Disabled,
   * `value` bindings, ...) keeps working unchanged reading `.value`
   * alone; only a caller that explicitly wants styled output (the Map
   * popup's Name/Description, so far) needs to check `.rich` too and
   * feed it through `rich-text-render.ts`'s `renderRichTextHtml`.
   */
  /** `pending`: the formula calls a function whose implementation (formula.js) is still loading - `value` is null for now and a reactive caller re-evaluates on its own once it arrives (see loadFormulaFunctions). */
  = | { ok: true, value: FormulaValue, rich?: FormulaRichSegment[], pending?: true }
  /** Never thrown to the caller - a parse error, an unknown identifier/function, a `MemberExpression`, or a runtime error (e.g. dividing incompatible types) all land here. Every caller falls back to the field's own static value - "a typo never silently breaks the form" is this file's own rule, every caller in the app follows it. */
    | { ok: false, error: string }

// --- Step 1: `{{col}}` -> bare identifier - extended with an OPTIONAL
// single dotted segment (`{{customer.name}}`) reaching one hop into a
// Foreign Key column's own related row (chat's own decision - a Kanban
// card title showing a raw FK id instead of the related row's name was
// the trigger). Applies EVERYWHERE a `{{col}}` token does - bindings
// v2's text/boolean/value bindings, Card/Map/Kanban layout formulas,
// and PROGRESS/AVATAR/USER's own config strings + a field's own Label
// (field-config.ts's `evaluateTemplateFormula`/`evaluateTemplateFormulaNumber`,
// migrated off the old, separate resolve-template.ts, since deleted -
// one engine, not two, for every `{{col}}` token in the app).
//
// Capped at ONE hop by this regex's own shape (never `{{a.b.c}}`) - same
// ceiling every FK picker in this app already holds to (ForeignKeySelect.
// vue, the Kanban groupColumn picker, ...), and it keeps `parseRelationFieldRefs`
// below a flat list instead of a tree.
const TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*\}\}/g

/**
 * The mangled, jsep-safe identifier a `{{col.related}}` token becomes
 * once `preprocess` strips the braces - NEVER a real dotted path
 * (`MemberExpression` stays unimplemented in `evaluateNode`, this file's
 * own top doc comment on why - a literal dot handed to jsep would parse
 * as exactly that forbidden node type). `___` (triple underscore) is
 * this file's own private wire format - a builder never types or sees
 * it; BindingButton's picker always inserts the real `{{col.related}}`
 * surface syntax, and every caller that fetches the row a formula runs
 * against has to populate `values` under this SAME key (never invent
 * their own scheme) - see `parseRelationFieldRefs`'s own doc comment for
 * the other half of this contract. Collision with a real column literally
 * named e.g. `customer___name` is astronomically unlikely - not defended
 * against further, same pragmatic tolerance `KANBAN_UNASSIGNED_KEY`
 * (types/dataview.ts) already takes with its own sentinel string.
 */
export function relationFieldKey(column: string, relatedColumn: string): string {
  return `${column}___${relatedColumn}`
}

function preprocess(source: string): string {
  return source.replace(TEMPLATE_TOKEN, (_match, column: string, related: string | undefined) =>
    related ? relationFieldKey(column, related) : column)
}

/**
 * Every ONE-HOP relation reference a formula makes (`{{fk.related}}`) -
 * used by whatever's about to FETCH the row this formula will run
 * against (never by `evaluateFormula` itself, which only ever sees
 * already-resolved flat `values`) to know which extra joined columns to
 * request from the Data API. The Data API's own `fields=` param already
 * supports an arbitrary one-hop dotted path natively (`packages/query-
 * engine`'s `path-resolver.ts` - a real `LEFT JOIN`, permission-gated
 * per field, reused across every path sharing the same FK prefix so
 * `{{customer.name}}` + `{{customer.email}}` together cost exactly ONE
 * join, not two) - this function only extracts WHICH paths a formula's
 * text mentions, `column.relatedColumn` pairs the caller then requests
 * verbatim as `fields=column.relatedColumn` and reads back from the
 * fetched row under that exact same dotted key (build-dataview-
 * columns.ts's own `displayFieldAlias` - reused here for ANY related
 * column, not just a field's configured `display_field`).
 */
export interface RelationFieldRef { column: string, relatedColumn: string }
export function parseRelationFieldRefs(source: string): RelationFieldRef[] {
  const refs: RelationFieldRef[] = []
  for (const match of source.matchAll(TEMPLATE_TOKEN)) {
    const [, column, related] = match
    if (column && related) refs.push({ column, relatedColumn: related })
  }
  return refs
}

// --- Step 3's allowlist - ONLY these names are ever callable from a formula, regardless of what formula.js itself exports. Add to this list to widen the language, nothing else needs to change. ---
type FxFn = (...args: unknown[]) => unknown
const ALLOWED_FUNCTION_NAMES = [
  // Logical
  'IF', 'IFS', 'AND', 'OR', 'NOT',
  // Text
  'CONCATENATE', 'UPPER', 'LOWER', 'TRIM', 'LEN', 'LEFT', 'RIGHT', 'MID', 'SUBSTITUTE',
  // Numeric
  'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'SUM', 'MIN', 'MAX', 'AVERAGE', 'PRODUCT', 'MOD', 'POWER', 'SQRT',
  // Blank/type checks
  'ISBLANK', 'ISNUMBER', 'ISTEXT',
  // Dates
  'DATE', 'TODAY', 'NOW', 'YEAR', 'MONTH', 'DAY', 'EDATE', 'DATEDIF'
] as const
const ALLOWED_FUNCTION_SET = new Set<string>(ALLOWED_FUNCTION_NAMES)

/**
 * formula.js (with jstat/bessel, ~150 KB) loads the first time a formula
 * actually CALLS one of the functions above - plain `{{col}}` templates,
 * arithmetic, comparisons and FORMAT functions never need it, and most
 * DataViews have no function call at all. Until it arrives such a formula
 * evaluates to `{ ok: true, value: null, pending: true }`; the table lives
 * in a shallowRef that evaluation reads, so any computed/render that got
 * the pending value re-evaluates by itself once it's loaded.
 */
const allowedFunctions = shallowRef<Record<string, FxFn> | null>(null)
let loadingFunctions: Promise<void> | null = null

export function loadFormulaFunctions(): Promise<void> {
  loadingFunctions ??= import('@formulajs/formulajs').then((fx) => {
    const table = fx as unknown as Record<string, FxFn>
    allowedFunctions.value = Object.fromEntries(ALLOWED_FUNCTION_NAMES.map(name => [name, table[name]!]))
  })
  return loadingFunctions
}

/** Thrown (internally) while formula.js is still loading - becomes a `pending` result, never an error. */
class FormulaPendingError extends Error {}

// --- FORMAT functions (BOLD/ITALIC/UNDERLINE/STRIKETHROUGH/COLOR/BADGE/
// LINK/NEW_LINE) - a SEPARATE dispatch from `ALLOWED_FUNCTION_NAMES` above,
// deliberately: `@formulajs/formulajs` has no notion of styled text, so
// these can't be `fx.*` entries - they're handled by hand in
// `evaluateNode`'s own `CallExpression` case, building/wrapping
// `FormulaRichSegment[]` instead of calling into formula.js at all.
// `CONCATENATE` itself is ALSO special-cased there (not delegated to
// `fx.CONCATENATE`) - it's the one function that has to notice when one
// of its arguments carries formatting and flatten every argument into
// ONE merged segment list instead of a plain string, while still
// behaving EXACTLY as before (a plain string result) when nothing rich
// is involved - the common, unstyled case (Card title, Popup name, ...)
// never even allocates a `RichText`.
/** Exported so `BindingButton.vue` can split its Functions sidebar section from a separate Format one, without hand-duplicating this exact name list a second time. */
export const FORMAT_FUNCTION_NAMES = new Set(['BOLD', 'ITALIC', 'UNDERLINE', 'STRIKETHROUGH', 'COLOR', 'BADGE', 'LINK', 'NEW_LINE', 'ICON'])
/**
 * Text from a number or a date, in the viewer's language (T52, DataViews.md §10) - the same
 * engine as a column's displayFormat (format-pattern.ts): FORMAT_NUMBER(v, 2 | "#,##0.00"), CURRENCY(v, "ARS"),
 * FORMAT_DATE(d, "dd/MM/yyyy"). Own functions, never formula.js - {{precio}} alone stays the raw number.
 */
export const TEXT_FORMAT_FUNCTION_NAMES = new Set(['FORMAT_NUMBER', 'CURRENCY', 'FORMAT_DATE'])
function evaluateTextFormatFunction(name: string, args: unknown[]): string {
  const value = args[0]
  if (value === null || value === undefined || value === '') return ''
  if (name === 'FORMAT_DATE') {
    const date = value instanceof Date ? value : typeof value === 'string' ? parseISO(value) : null
    if (!date || !isValidDate(date)) return String(value)
    const pattern = typeof args[1] === 'string' && args[1] ? args[1] : null
    try {
      return pattern ? formatDateFns(date, pattern, { locale: uiDateFnsLocale() }) : date.toLocaleDateString(uiIntlLocale())
    } catch {
      throw new FormulaEvalError('datePattern', { pattern: pattern ?? '' })
    }
  }
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (name === 'CURRENCY') {
    if (typeof args[1] !== 'string' || !/^[A-Za-z]{3}$/.test(args[1])) throw new FormulaEvalError('currencyCode')
    return formatNumberValue(n, `CURRENCY:${args[1].toUpperCase()}`)
  }
  const spec = args[1]
  const pattern = typeof spec === 'string' && spec ? spec : `#,##0${Number(spec) > 0 ? `.${'0'.repeat(Math.min(Number(spec), 10))}` : ''}`
  return formatNumberValue(n, pattern)
}

const ROLE_COLOR_SET: Set<string> = new Set(ROLE_COLOR_OPTIONS)
/**
 * The shape of a lucide icon name (`i-lucide-circle-check`): the prefix, then
 * lowercase words and digits joined by single hyphens. A shape check, not the
 * catalog: the full name list (utils/lucide-icon-names.ts, ~49 KB) is the
 * icon picker's, loaded when a picker opens - this engine runs on every App
 * viewer's grid and must not ship it. A well-formed name that no icon has
 * renders as nothing (the renderer finds no SVG), the same degrade as before.
 */
const LUCIDE_ICON_NAME_PATTERN = /^i-lucide-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A foreign key's value: its key, and the text its row shows as (`foreignKeyText`). Internal, like RichText. */
class ForeignKeyValue {
  constructor(public key: unknown, public text: string) {}
}
/** A foreign key as text - anything else as it is. */
function asText(value: unknown): unknown {
  return value instanceof ForeignKeyValue ? value.text : value
}
/** A foreign key as its key - anything else as it is. */
function asKey(value: unknown): unknown {
  return value instanceof ForeignKeyValue ? value.key : value
}

/** Internal-only wrapper `evaluateNode` passes around for a FORMAT function's result - never leaks past `coerceResult` (which flattens it into `.value`/`.rich`), so nothing outside this file ever sees this class. */
class RichText {
  constructor(public segments: FormulaRichSegment[]) {}
}
function isRichText(value: unknown): value is RichText {
  return value instanceof RichText
}
/** `.value`'s own flattened plain-text fallback for a rich result - formatting stripped, `break` segments become a real `"\n"` (so a caller that never reads `.rich` still gets a sane, readable string; `DataViewMap.vue`'s own `escapeHtml`+plain `<p>` render would show that literal `\n` collapsed to a space today - a real line break there needs `white-space: pre-line`, unrelated to this file). */
function flattenRichText(segments: FormulaRichSegment[]): string {
  return segments.map(s => s.break ? '\n' : s.text).join('')
}
/** Any evaluated arg (a `RichText` from a nested FORMAT call, or a plain string/number/boolean/Date/null) -> its own segment list, for `CONCATENATE`/a FORMAT function's own single-argument wrap. */
function toSegments(value: unknown): FormulaRichSegment[] {
  if (isRichText(value)) return value.segments
  if (value === null || value === undefined) return [{ text: '' }]
  if (value instanceof Date) return [{ text: value.toISOString() }]
  return [{ text: String(value) }]
}
/** BOLD/ITALIC/UNDERLINE/STRIKETHROUGH/COLOR/BADGE/LINK all apply ONE flag over their (possibly already-formatted) first argument - a `break` segment (`NEW_LINE()`) carries no text to style, so it's passed through untouched rather than e.g. becoming an empty bold run. */
function withFlag(segments: FormulaRichSegment[], patch: Partial<FormulaRichSegment>): FormulaRichSegment[] {
  return segments.map(s => s.break ? s : { ...s, ...patch })
}
/**
 * `http(s)/mailto/tel` or a same-origin relative path only - anything
 * else (most importantly `javascript:`/`data:`/`vbscript:`) is REJECTED
 * outright, never attached to a segment's `link` (LINK's own handler
 * below just drops the link and keeps the plain text instead of
 * throwing - "never breaks the form" rule). A column's raw value can
 * end up here (`LINK({{label}}, {{profile_url}})`) so this can't just
 * trust whatever string shows up.
 */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])
function validateLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const url = value.trim()
  // A scheme-less/relative path (`/records/123`, `#section`, `?x=1`) has
  // no `://` before its first `/`/`?`/`#` - `new URL` needs a base to
  // parse those at all; same-origin navigation is never a script risk,
  // so these are allowed without further checks.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url
  try {
    const parsed = new URL(url)
    return SAFE_LINK_SCHEMES.has(parsed.protocol) ? url : null
  } catch {
    return null
  }
}
function validateLinkTarget(value: unknown): LinkTarget {
  return typeof value === 'string' && (LINK_TARGETS as readonly string[]).includes(value) ? (value as LinkTarget) : '_self'
}
function evaluateFormatFunction(name: string, args: unknown[]): RichText {
  if (name === 'NEW_LINE') return new RichText([{ text: '', break: true }])
  // ICON's one argument IS the icon name, not text to wrap/style - the
  // ONLY format function whose argument isn't itself renderable text,
  // so it can't go through `toSegments(args[0])` like every other one
  // below does. An unknown/invalid name just drops the icon entirely
  // (empty segment list) - same "never throws" degrade as an invalid
  // LINK url/COLOR.
  //
  // Lucide-only for now, by design (not a temporary gap): `LUCIDE_ICON_
  // NAME_PATTERN` is the one shape this accepts (the name list itself
  // stays out of the viewer's bundle - see its doc comment),
  // and `rich-text-render.ts`'s icon renderer only knows how to resolve
  // an `i-lucide-*` name (see that file's own doc comment on why - a
  // dynamic per-icon backend endpoint would be the right move to add a
  // second family like Simple Icons or Material Symbols, since bundling
  // one of those whole client-side the way Lucide's JSON is loaded here
  // would be multiple MB, but that's future work with no consumer yet -
  // don't build it speculatively). Adding a family means: extend this
  // check to accept its own prefix too, AND give the renderer
  // a way to resolve that prefix's SVG body.
  if (name === 'ICON') {
    const icon = typeof args[0] === 'string' && LUCIDE_ICON_NAME_PATTERN.test(args[0]) ? args[0] : null
    return new RichText(icon ? [{ text: '', icon }] : [])
  }
  const inner = toSegments(args[0])
  switch (name) {
    case 'BOLD': return new RichText(withFlag(inner, { bold: true }))
    case 'ITALIC': return new RichText(withFlag(inner, { italic: true }))
    case 'UNDERLINE': return new RichText(withFlag(inner, { underline: true }))
    case 'STRIKETHROUGH': return new RichText(withFlag(inner, { strikethrough: true }))
    case 'COLOR': {
      const color = typeof args[1] === 'string' && ROLE_COLOR_SET.has(args[1]) ? (args[1] as RoleColor) : undefined
      return new RichText(color ? withFlag(inner, { color }) : inner)
    }
    case 'BADGE': {
      const color = typeof args[1] === 'string' && ROLE_COLOR_SET.has(args[1]) ? (args[1] as RoleColor) : undefined
      return new RichText(color ? withFlag(inner, { badge: color }) : inner)
    }
    case 'LINK': {
      const url = validateLinkUrl(args[1])
      const target = validateLinkTarget(args[2])
      return new RichText(url ? withFlag(inner, { link: { url, target } }) : inner)
    }
    default:
      throw new FormulaEvalError('unknownFormat', { name })
  }
}

/** A short, human `NAME(args)` signature per allowlisted function - FormulaEditor.vue's own autocomplete/hover, so the picker never drifts from what `ALLOWED_FUNCTION_NAMES` actually accepts (one list, not two). */
export const FORMULA_FUNCTION_SIGNATURES: Record<string, string> = {
  IF: 'IF(condition, then, else)',
  IFS: 'IFS(cond1, value1, cond2, value2, ...)',
  AND: 'AND(a, b, ...)',
  OR: 'OR(a, b, ...)',
  NOT: 'NOT(value)',
  CONCATENATE: 'CONCATENATE(text1, text2, ...)',
  UPPER: 'UPPER(text)',
  LOWER: 'LOWER(text)',
  TRIM: 'TRIM(text)',
  LEN: 'LEN(text)',
  LEFT: 'LEFT(text, count)',
  RIGHT: 'RIGHT(text, count)',
  MID: 'MID(text, start, count)',
  SUBSTITUTE: 'SUBSTITUTE(text, old, new)',
  ROUND: 'ROUND(number, digits)',
  ROUNDUP: 'ROUNDUP(number, digits)',
  ROUNDDOWN: 'ROUNDDOWN(number, digits)',
  ABS: 'ABS(number)',
  SUM: 'SUM(a, b, ...)',
  MIN: 'MIN(a, b, ...)',
  MAX: 'MAX(a, b, ...)',
  AVERAGE: 'AVERAGE(a, b, ...)',
  PRODUCT: 'PRODUCT(a, b, ...)',
  MOD: 'MOD(number, divisor)',
  POWER: 'POWER(number, exponent)',
  SQRT: 'SQRT(number)',
  ISBLANK: 'ISBLANK(value)',
  ISNUMBER: 'ISNUMBER(value)',
  ISTEXT: 'ISTEXT(value)',
  DATE: 'DATE(year, month, day)',
  TODAY: 'TODAY()',
  NOW: 'NOW()',
  YEAR: 'YEAR(date)',
  MONTH: 'MONTH(date)',
  DAY: 'DAY(date)',
  EDATE: 'EDATE(date, months)',
  DATEDIF: 'DATEDIF(start, end, unit)',
  FORMAT_NUMBER: 'FORMAT_NUMBER(number, decimals)',
  CURRENCY: 'CURRENCY(number, code)',
  FORMAT_DATE: 'FORMAT_DATE(date, pattern)',
  // Format - text-only (kind="text" bindings), see FORMAT_FUNCTION_NAMES's own doc comment.
  BOLD: 'BOLD(text)',
  ITALIC: 'ITALIC(text)',
  UNDERLINE: 'UNDERLINE(text)',
  STRIKETHROUGH: 'STRIKETHROUGH(text)',
  COLOR: 'COLOR(text, roleColor)',
  BADGE: 'BADGE(text, roleColor)',
  LINK: 'LINK(text, url, target)',
  NEW_LINE: 'NEW_LINE()',
  ICON: 'ICON(iconName)'
}

/**
 * A real, valid EXAMPLE call per function (not the human-readable
 * signature above, which uses placeholder NAMES like `text`/`digits`
 * that aren't meant to be inserted literally) - `BindingButton.vue`'s
 * own Functions section inserts THIS at the cursor/selection instead of
 * a bare `NAME(`, so a builder immediately sees a working shape
 * ("CONCATENATE("val1", "val2", "valN")") they can then edit/replace
 * piece by piece (select "val1", click a Field) rather than typing
 * every argument from scratch. Generic `"val1"`/`"val2"`/... placeholder
 * TEXT for every argument regardless of the function's real expected
 * type (a number function like `ROUND` still gets `"val1", "val2"`) -
 * deliberately mechanical/uniform rather than "smart" per function.
 */
export const FORMULA_FUNCTION_INSERT_TEMPLATES: Record<string, string> = Object.fromEntries(
  Object.entries(FORMULA_FUNCTION_SIGNATURES).map(([name, signature]) => {
    const params = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')')).trim()
    if (!params) return [name, `${name}()`]
    const raw = params.split(',').map(p => p.trim())
    // A variadic signature (`text1, text2, ...`) gets a literal `"valN"`
    // as its last placeholder instead of a numbered one - signals "put
    // as many as you want here".
    const isVariadic = raw[raw.length - 1] === '...'
    const fixed = isVariadic ? raw.slice(0, -1) : raw
    const args = fixed.map((_, i) => `"val${i + 1}"`)
    if (isVariadic) args.push('"valN"')
    return [name, `${name}(${args.join(', ')})`]
  })
)

// --- Date boxing - raw stored string <-> real `Date`, only at the Identifier/result boundary. `time` has no real calendar date of its own; anchored to a fixed reference (NOT "now") so arithmetic is deterministic regardless of when it runs. ---
const TIME_REFERENCE = new Date(1970, 0, 1)

function boxTemporal(raw: unknown, kind: TemporalKind, timezone: string | undefined): Date | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    if (kind === 'time') {
      const parsed = parseDateFns(raw, 'HH:mm:ss', TIME_REFERENCE)
      return isValidDate(parsed) ? parsed : null
    }
    const parsed = parseISO(raw)
    if (!isValidDate(parsed)) return null
    // `datetime` + timezone: the raw value is a UTC instant - convert to
    // the viewer's own wall-clock time so DAY-based arithmetic (`+30`
    // meaning 30 days) lines up with the calendar day the viewer is
    // actually looking at, not whatever day UTC happens to be at that
    // instant (someone in Argentina at 21:00 local is already the
    // next day in UTC).
    return kind === 'datetime' && timezone ? toZonedTime(parsed, timezone) : parsed
  } catch {
    return null
  }
}

/**
 * `Date` -> the raw shape a `value`-bound column of this `kind` expects
 * (the OTHER half of `boxTemporal`). `date`/`time` never touch
 * timezone (naive, no offset - same rule `format-pattern.ts` already
 * follows); `datetime` converts the wall-clock result back to a real
 * UTC instant before serializing, mirroring `boxTemporal`'s own
 * zoned-time conversion on the way in.
 */
function unboxTemporal(date: Date, kind: TemporalKind, timezone: string | undefined): string {
  if (kind === 'time') return formatDateFns(date, 'HH:mm:ss')
  if (kind === 'date') return formatDateFns(date, 'yyyy-MM-dd')
  const instant = timezone ? fromZonedTime(date, timezone) : date
  return instant.toISOString()
}

/**
 * `+`/`-` on a boxed date - Excel-FLAVORED, not byte-for-byte Excel (no
 * day-serial numbers travel through the rest of the evaluator, just
 * real `Date`s with special-cased arithmetic here). Chosen unit per
 * kind, not one blanket rule - `date`/`datetime` add DAYS
 * (`{{fecha_desde}} + 30`), `time` adds MINUTES (a
 * bare time-of-day plus 30 reads as "30 minutes later", not "30 days
 * later", which is meaningless for a value with no calendar date at
 * all). `date - date` reads as calendar days apart (DST-agnostic by
 * design - `date` has no time-of-day to be DST-ambiguous about);
 * `datetime - datetime` is documented as a simplification: whole
 * 24-hour days by calendar difference in the LOCAL (already zoned, see
 * `boxTemporal`) wall-clock date, not a precise elapsed-time count -
 * good enough for "how many days between these two timestamps", not a
 * duration/stopwatch calculation.
 */
function dateArith(operator: '+' | '-', left: unknown, right: unknown): Date | number | null {
  const leftDate = left instanceof Date ? left : null
  const rightDate = right instanceof Date ? right : null
  if (leftDate && rightDate) {
    const days = differenceInCalendarDays(leftDate, rightDate)
    return operator === '-' ? days : null // `date + date` isn't a real operation - null surfaces as an evaluation error
  }
  const [dateOperand, numberOperand, dateIsLeft] = leftDate ? [leftDate, right, true] as const : [rightDate, left, false] as const
  if (!dateOperand || typeof numberOperand !== 'number') return null
  if (operator === '-' && !dateIsLeft) return null // `30 - {{fecha}}` isn't a real operation either
  const delta = operator === '-' ? -numberOperand : numberOperand
  // `time`'s own reference (TIME_REFERENCE) has no meaningful year/month/day
  // to add DAYS to - minutes only for that kind, days for date/datetime.
  const isTimeOnly = dateOperand.getFullYear() === TIME_REFERENCE.getFullYear()
    && dateOperand.getMonth() === TIME_REFERENCE.getMonth()
    && dateOperand.getDate() === TIME_REFERENCE.getDate()
  return isTimeOnly ? addMinutes(dateOperand, delta) : addDays(dateOperand, delta)
}

// --- Step 2: the evaluator itself. ---

const SUPPORTED_UNARY = new Set(['-', '!'])
const SUPPORTED_BINARY = new Set(['+', '-', '*', '/', '%', '==', '!=', '===', '!==', '>', '>=', '<', '<='])
const SUPPORTED_LOGICAL = new Set(['&&', '||'])

/** A formula's own errors - each a key of `dataviews.formulaErrors`, with what it names. */
export const FORMULA_ERROR_CODES = [
  'datePattern', 'currencyCode', 'unknownFormat', 'expectedNumber', 'richOperator', 'invalidBetween', 'divisionByZero',
  'unsupportedOperator', 'unknownField', 'plainFunctionName', 'unknownFunction', 'unsupportedExpression', 'notNumber', 'notDate', 'syntax', 'invalid'
] as const
type FormulaErrorCode = (typeof FORMULA_ERROR_CODES)[number]

/** A formula error's text in the UI's language (Admin_UI.md §14) - its key where there is no Nuxt app (a unit test). */
function formulaErrorText(code: FormulaErrorCode, params: Record<string, string> = {}): string {
  try {
    return useNuxtApp().$i18n.t(`dataviews.formulaErrors.${code}`, params)
  } catch {
    return `dataviews.formulaErrors.${code}`
  }
}

/** TotalBase's own words, translated; a formula function's own result (formulajs' `#DIV/0!`, `#VALUE!`) reads the same in every language and passes as it is. */
class FormulaEvalError extends Error {
  constructor(code: FormulaErrorCode | { raw: string }, params?: Record<string, string>) {
    super(typeof code === 'object' ? code.raw : formulaErrorText(code, params))
  }
}

function toNumber(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new FormulaEvalError('expectedNumber', { context })
  return n
}

function evaluateBinary(operator: string, left: unknown, right: unknown): unknown {
  // A foreign key joins text as the row it shows, and compares or counts as its key.
  if (left instanceof ForeignKeyValue || right instanceof ForeignKeyValue) {
    const joinsText = operator === '+' && [left, right].some(v => typeof v === 'string' || v instanceof ForeignKeyValue || isRichText(v))
    return evaluateBinary(operator, joinsText ? asText(left) : asKey(left), joinsText ? asText(right) : asKey(right))
  }
  // A FORMAT function's result (BOLD/ITALIC/.../NEW_LINE) is a `RichText`
  // instance, not a plain string - ONLY `CONCATENATE` knows how to merge
  // it into a real styled segment list (this file's own top doc comment
  // on why: it's the one allowlisted function that checks for it).
  // Without this guard, `{{a}} + NEW_LINE() + {{b}}` silently fell into
  // the plain string-concat branch below and template-literal-stringified
  // the RichText object itself (`${richTextInstance}` -> the default
  // `"[object Object]"`, no error, no line break, just wrong output) -
  // a real bug found from a user report, not a hypothetical. Every
  // binary operator (`+`/`-`/comparisons/etc) is equally meaningless
  // against a RichText value, so this guard covers all of them, not
  // just `+`.
  if (isRichText(left) || isRichText(right)) {
    throw new FormulaEvalError('richOperator', { operator })
  }
  if (operator === '+' || operator === '-') {
    if (left instanceof Date || right instanceof Date) {
      const result = dateArith(operator, left, right)
      if (result === null) throw new FormulaEvalError('invalidBetween', { operator })
      return result
    }
    // `+` is a second, older way to join text (this file's own top doc
    // comment: `"Hola, " + {{nombre}}`) - needs the SAME RichText
    // awareness `CONCATENATE` has, or `BOLD("Email: ") + {{email}}`
    // would silently stringify the RichText object instead of merging
    // segments (`${left}` on a plain class instance -> "[object
    // Object]"). Same "only allocate a RichText when one's actually
    // involved" rule CONCATENATE's own dispatch in evaluateNode follows.
    if (operator === '+' && (isRichText(left) || isRichText(right))) {
      return new RichText([...toSegments(left), ...toSegments(right)])
    }
    if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) {
      return `${left ?? ''}${right ?? ''}`
    }
    const a = toNumber(left, `"${operator}"`)
    const b = toNumber(right, `"${operator}"`)
    return operator === '+' ? a + b : a - b
  }
  if (operator === '*') return toNumber(left, '"*"') * toNumber(right, '"*"')
  if (operator === '/') {
    const b = toNumber(right, '"/"')
    if (b === 0) throw new FormulaEvalError('divisionByZero')
    return toNumber(left, '"/"') / b
  }
  if (operator === '%') return toNumber(left, '"%"') % toNumber(right, '"%"')
  if (operator === '==' || operator === '===') {
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
    return left === right
  }
  if (operator === '!=' || operator === '!==') {
    if (left instanceof Date && right instanceof Date) return left.getTime() !== right.getTime()
    return left !== right
  }
  const [a, b] = left instanceof Date && right instanceof Date ? [left.getTime(), right.getTime()] : [left, right]
  if (operator === '>') return (a as number) > (b as number)
  if (operator === '>=') return (a as number) >= (b as number)
  if (operator === '<') return (a as number) < (b as number)
  if (operator === '<=') return (a as number) <= (b as number)
  throw new FormulaEvalError('unsupportedOperator', { operator })
}

interface EvalContext {
  values: Record<string, unknown>
  foreignKeyText: Record<string, string>
  columnKinds: Record<string, TemporalKind | undefined>
  timezone: string | undefined
}

function evaluateNode(node: jsep.Expression, ctx: EvalContext): unknown {
  switch (node.type) {
    case 'Literal':
      return (node as jsep.Literal).value
    case 'Identifier': {
      const name = (node as jsep.Identifier).name
      if (!(name in ctx.values)) throw new FormulaEvalError('unknownField', { name })
      const raw = ctx.values[name]
      const kind = ctx.columnKinds[name]
      if (kind) {
        const boxed = boxTemporal(raw, kind, ctx.timezone)
        return boxed // null (unset/unparseable) flows through like any other empty value
      }
      const text = ctx.foreignKeyText[name]
      if (text !== undefined && raw !== null && raw !== undefined) return new ForeignKeyValue(raw, text)
      return raw ?? null
    }
    case 'UnaryExpression': {
      const n = node as jsep.UnaryExpression
      if (!SUPPORTED_UNARY.has(n.operator)) throw new FormulaEvalError('unsupportedOperator', { operator: n.operator })
      const value = evaluateNode(n.argument, ctx)
      return n.operator === '!' ? !value : -toNumber(asKey(value), '"-"')
    }
    // `&&`/`||` come through as a plain `BinaryExpression` too - this
    // jsep version (confirmed against the installed package directly,
    // not assumed) has no separate `LogicalExpression` node type at
    // all, unlike some other JS expression parsers. Handled first, and
    // separately from the rest of `evaluateBinary`, because they need
    // real short-circuit evaluation (`right` only evaluated when it
    // can actually matter) - every other binary operator below always
    // evaluates both sides, which is fine for them (pure, no side
    // effects to skip), but wrong for `&&`/`||`.
    case 'BinaryExpression': {
      const n = node as jsep.BinaryExpression
      if (SUPPORTED_LOGICAL.has(n.operator)) {
        const left = evaluateNode(n.left, ctx)
        if (n.operator === '&&') return left ? evaluateNode(n.right, ctx) : left
        return left ? left : evaluateNode(n.right, ctx)
      }
      if (!SUPPORTED_BINARY.has(n.operator)) throw new FormulaEvalError('unsupportedOperator', { operator: n.operator })
      return evaluateBinary(n.operator, evaluateNode(n.left, ctx), evaluateNode(n.right, ctx))
    }
    case 'ConditionalExpression': {
      const n = node as jsep.ConditionalExpression
      return evaluateNode(n.test, ctx) ? evaluateNode(n.consequent, ctx) : evaluateNode(n.alternate, ctx)
    }
    case 'ArrayExpression': {
      const n = node as jsep.ArrayExpression
      return n.elements.filter((e): e is jsep.Expression => e !== null).map(e => asText(evaluateNode(e, ctx)))
    }
    case 'CallExpression': {
      const n = node as jsep.CallExpression
      if (n.callee.type !== 'Identifier') throw new FormulaEvalError('plainFunctionName')
      const name = (n.callee as jsep.Identifier).name
      // A function gets a foreign key as the text its row shows (UPPER, CONCATENATE, BOLD...).
      const args = n.arguments.map(a => asText(evaluateNode(a, ctx)))
      // FORMAT functions never touch `fx.*` (formula.js has no notion of
      // styled text) - handled entirely by hand, see `FORMAT_FUNCTION_
      // NAMES`'s own doc comment.
      if (FORMAT_FUNCTION_NAMES.has(name)) return evaluateFormatFunction(name, args)
      if (TEXT_FORMAT_FUNCTION_NAMES.has(name)) return evaluateTextFormatFunction(name, args)
      // `CONCATENATE` is the one allowlisted function that ALSO needs
      // to notice rich args (a nested BOLD/ITALIC/.../NEW_LINE) and
      // merge segment lists instead of joining plain strings - but ONLY
      // when at least one argument actually IS rich, so the common
      // unstyled case behaves exactly as before (a plain `fx.CONCATENATE`
      // call, never allocating a `RichText`).
      if (name === 'CONCATENATE' && args.some(isRichText)) {
        return new RichText(args.flatMap(toSegments))
      }
      if (!ALLOWED_FUNCTION_SET.has(name)) throw new FormulaEvalError('unknownFunction', { name })
      const functions = allowedFunctions.value
      if (!functions) {
        void loadFormulaFunctions()
        throw new FormulaPendingError()
      }
      const result = functions[name]!(...args)
      if (result instanceof Error) throw new FormulaEvalError({ raw: String(result.message ?? result) })
      return result
    }
    // `MemberExpression` (`a.b`, `a["b"]`) has NO case - deliberately
    // unimplemented, not merely disallowed (this file's own top doc
    // comment on why). Falls through to the default below, same as any
    // other node type jsep can parse but this evaluator doesn't know.
    default:
      throw new FormulaEvalError('unsupportedExpression', { type: node.type })
  }
}

function coerceResult(value: unknown, returnType: FormulaReturnType | undefined, timezone: string | undefined): FormulaValue {
  if (value === null || value === undefined) return null
  if (!returnType) {
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    return String(value)
  }
  if (returnType === 'string') return value instanceof Date ? unboxTemporal(value, 'datetime', timezone) : String(value)
  if (returnType === 'number') {
    const n = value instanceof Date ? value.getTime() : Number(value)
    if (!Number.isFinite(n)) throw new FormulaEvalError('notNumber')
    return n
  }
  if (returnType === 'boolean') return Boolean(value)
  // A TemporalKind - the result must already be a boxed Date (from a
  // temporal Identifier, dateArith, or a formula.js date function like
  // EDATE/TODAY/NOW, which already return real Dates - confirmed
  // against the installed package directly, not assumed).
  if (!(value instanceof Date)) throw new FormulaEvalError('notDate')
  return unboxTemporal(value, returnType, timezone)
}

/**
 * Parses and evaluates one formula against one record's current values.
 * Never throws - a parse failure, an unknown field/function, a
 * `MemberExpression`, or a runtime type error all come back as
 * `{ ok: false, error }`; the caller decides the fallback (the field's
 * own static config value).
 */
/** The formula's tree - a text jsep can't read is the formula's own `syntax` error, not jsep's English. */
function parseFormula(source: string): jsep.Expression {
  try {
    return jsep(preprocess(source))
  } catch {
    throw new FormulaEvalError('syntax')
  }
}

export function evaluateFormula(source: string, options: EvaluateFormulaOptions): EvaluateFormulaResult {
  const trimmed = source.trim()
  if (!trimmed) return { ok: true, value: null }
  try {
    const ast = parseFormula(trimmed)
    const ctx: EvalContext = { values: options.values, foreignKeyText: options.foreignKeyText ?? {}, columnKinds: options.columnKinds ?? {}, timezone: options.timezone }
    const result = evaluateNode(ast, ctx)
    // The result is text unless it must be a number, a boolean or a date: a foreign key shows as its row.
    const raw = result instanceof ForeignKeyValue ? (options.returnType === 'string' || !options.returnType ? result.text : result.key) : result
    if (isRichText(raw)) {
      return { ok: true, value: coerceResult(flattenRichText(raw.segments), options.returnType, options.timezone), rich: raw.segments }
    }
    return { ok: true, value: coerceResult(raw, options.returnType, options.timezone) }
  } catch (err) {
    if (err instanceof FormulaPendingError) return { ok: true, value: null, pending: true }
    return { ok: false, error: err instanceof Error ? err.message : formulaErrorText('invalid') }
  }
}

/**
 * Every `{{column}}` a formula references - used to build the `value`
 * binding dependency graph (which computed field depends on which
 * others) without re-parsing for that purpose; walks the SAME AST
 * `evaluateFormula` would, just collecting `Identifier` names instead
 * of evaluating them. Returns an empty set (never throws) for a
 * formula that fails to parse - the graph-builder's own caller decides
 * what an unparseable formula means for save-time validation.
 */
export function formulaDependencies(source: string): Set<string> {
  const names = new Set<string>()
  try {
    const ast = jsep(preprocess(source.trim()))
    collectIdentifiers(ast, names)
  } catch {
    // Unparseable - no dependencies to report; the formula's own save-time validation is what surfaces the real error.
  }
  return names
}

function collectIdentifiers(node: jsep.Expression, names: Set<string>): void {
  if (node.type === 'Identifier') {
    names.add((node as jsep.Identifier).name)
    return
  }
  // A CallExpression's own `callee` is a FUNCTION name (`IF`, `ROUND`,
  // ...), never a field reference - only its `arguments` can contain
  // real field dependencies. Skipped here the same way `evaluateNode`'s
  // own CallExpression case reads `callee.name` directly rather than
  // evaluating it as a value.
  if (node.type === 'CallExpression') {
    for (const arg of (node as jsep.CallExpression).arguments) collectIdentifiers(arg, names)
    return
  }
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'type' in item) collectIdentifiers(item as jsep.Expression, names)
      }
    } else if (value && typeof value === 'object' && 'type' in value) {
      collectIdentifiers(value as jsep.Expression, names)
    }
  }
}
