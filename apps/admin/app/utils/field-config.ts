import type { RelationDetail } from '~/types/schema'
import type { GridCellConfig, WidgetName } from '@totalbase/tb-catalog'
import { evaluateFormula, type FormulaReturnType } from '~/utils/formula-engine'

/**
 * Shape of `dataviews_fields.config` (jsonb, no CHECK on it - free-form by
 * design) beyond the two keys that already existed before this file
 * (`help`, `display_field`) - the Design form's Validation/Advanced tabs
 * (a survey of Retool/Appsmith/Budibase/Directus/JSON-Schema all
 * converge on roughly this set). Every key is
 * optional and consumers (DataViewRecordPanel) must treat a missing key as
 * "no constraint", never assume presence.
 */
export interface FieldConfig {
  /**
   * A display label distinct from the column's real Postgres name (e.g.
   * `published_at` -> "Published"). `totalbase.resources_columns` (unlike
   * `dataviews_fields`) has no dedicated `label` column of its own, only
   * `widget`/`config` - this is the seed a DataView field created later
   * reads for its own real `label` column, same "seed, not source of
   * truth" role this whole config already plays (see that table's own
   * comment).
   */
  label?: string
  help?: string
  /** FK only - which column of the related table to show instead of its raw key (a template's first column, when it has one). */
  display_field?: string
  /** FK only - a template over the related table's columns shown instead (`{{name}} ({{country}})`, utils/display-field.ts). */
  display_template?: string
  /**
   * FK only, set alongside `display_field` at the same time (Design
   * form's inspector) - the related table's own identity, straight off
   * `RelationDetail.relations` at save time so neither the grid nor the
   * Edit form ever needs a live catalog round trip just to resolve
   * "which table does this FK point at": `column` is the target's own
   * referenced column (normally its PK) - what this field's raw value
   * actually equals, not `display_field` itself.
   */
  display_field_target?: { schema: string, table: string, column: string }
  /** Read only: the display above is its table's row presentation, inherited (DataViews.md §15.5) - sent back unchanged, none of it is stored. */
  display_inherited?: boolean
  /** Set by the App for a viewer who may not read `display_field` on the related resource - the raw key is shown instead of the join. */
  display_field_denied?: boolean

  /**
   * `UFormField`'s own `description` (shown below the label, above the
   * input) - real Nuxt UI prop, wired straight through
   * (WidgetRenderer.vue). Distinct from `help` (below the
   * INPUT, not the label) and from the runtime's own hardcoded "Primary
   * key - not editable" note, which uses `hint` instead so it never
   * collides with whatever the builder writes here.
   */
  description?: string
  /** `UFormField`'s own `hint` (shown to the right of the label, meant to be short) - real Nuxt UI prop. */
  hint?: string
  /** `UFormField`'s own `orientation` - default 'vertical' (Nuxt UI's own default) when unset. */
  orientation?: 'horizontal' | 'vertical'

  placeholder?: string
  /** Mirrors the DB's NOT NULL when locked (see columnConstraintsFor) - always forced true then, editable only when the column itself is nullable. */
  required?: boolean
  disabled?: boolean
  readonly?: boolean
  defaultValue?: string | number | boolean

  minLength?: number
  maxLength?: number
  /** A plain regex source (no delimiters/flags) - validated client-side against string values. */
  pattern?: string
  patternMessage?: string

  min?: number
  max?: number
  step?: number
  decimals?: number

  prefix?: string
  suffix?: string

  /** USelect/USelectMenu/UInputMenu/UListbox/URadioGroup/UCheckboxGroup, non-FK only - a manually authored option list (real enums aren't detected from CHECK constraints yet, see widget-compatibility.ts's own doc comment for why). */
  options?: { value: string, label: string }[]
  /** USelect/USelectMenu/UInputMenu/UListbox only - RadioGroup/CheckboxGroup are inherently single/multiple already, no toggle needed. */
  multiple?: boolean

  /** UInputRating only - how many stars/icons to show (Nuxt UI's own `length`, default 5). */
  ratingLength?: number
  /** UPinInput only - how many boxes to show (Nuxt UI's own `length`, default 5). */
  pinLength?: number
  /** UEditor only - which of `UEditor`'s three `contentType`s this field's `text`/`jsonb` column holds (packages/tb-catalog/src/widgets/widget-catalog.ts's UEditorMarkdown/UEditorBlocks/UEditorHtml creation entries map onto one of these). Defaults to 'markdown' when unset (WidgetRenderer.vue's own widgetProps()). */
  editorContentType?: 'markdown' | 'html' | 'json'

  // --- Appearance: standard HTML attributes / Nuxt UI props that are
  // common enough (and well-known enough, spelled out in Nuxt UI's own
  // docs) to deserve their own curated control instead of leaving them to
  // the free-form `htmlAttrs` below - a plain text box can't express a
  // boolean like `autofocus` cleanly, and `size` reads better as a select
  // than a typo-prone string.
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  icon?: string
  autofocus?: boolean
  autocomplete?: string
  tabindex?: number
  ariaLabel?: string
  /** Extra Tailwind classes appended to the widget - an escape hatch for a one-off visual tweak, not a replacement for `size`/`icon` above. */
  cssClass?: string
  /** UInput only - the native HTML `type` , e.g. `number`/`email`/`password`/`file`. UInput itself defaults to `text`; this is likely to be one of the most-used properties once set, since so much of a real form is one of these. */
  inputType?: string

  /**
   * Excel/JasperReports-style DISPLAY pattern (utils/format-pattern.ts) -
   * a completely separate concern from every EDITING knob above
   * (min/max/decimals/step/...) AND from the WIDGET choice: this is
   * gated by the column's real Postgres type (numeric or date/time/
   * timestamp), never by which widget happens to be selected - a
   * `UInputDate`/`UInputTime` column can have one configured exactly
   * like a plain `UInput` one (tying it to
   * the widget meant a datetime column stuck with the native
   * `UInputDate` picker could never get a formatted GRID cell either,
   * even though the grid never renders that widget at all).
   *
   * What actually reads it differs by consumer:
   * - The GRID (build-dataview-columns.ts) always applies it, for
   *   every widget, since it never renders a live widget in the first
   *   place - just this pattern against the raw value.
   * - The FORM only live-applies it for `UInputNumber` (feeds its own
   *   `formatOptions`/`step`/`locale`, no new component needed - reka-
   *   ui's NumberField already does "raw while typing, formatted on
   *   blur") and for `UInput` with `inputType` unset/`text`
   *   (WidgetFormattedDate.vue - a plain masked text input). Every
   *   other widget (`UInputDate`/`UInputTime`/`USlider`/
   *   `UInputRating`/...) keeps its own native editing behavior
   *   untouched in the form - native browser/reka-ui pickers have no
   *   prop a custom pattern could override - but the GRID still shows
   *   the formatted value regardless.
   */
  displayFormat?: string
  /**
   * Which engine `displayFormat` needs - `'number'` or one of the 3
   * Postgres temporal shapes (date/time/timestamp) - auto-derived from
   * the column's real Postgres type at configure time (never a
   * separate choice the builder makes) and persisted here so the GRID
   * (which never looks up the live catalog) knows which call applies
   * without re-resolving anything.
   */
  displayFormatKind?: 'number' | 'date' | 'time' | 'datetime'
  /**
   * `true` only for a real `timestamp with time zone` column - never for
   * a naive `timestamp`/`date`/`time` (nothing to convert, they carry no
   * offset at all). Auto-derived and persisted alongside
   * `displayFormatKind`, same reasoning. Read by whichever consumer
   * applies the Settings > General timezone default
   * (packages/settings `system.timezone`): a naive column's
   * wall-clock value is shown as stored, always, regardless of that
   * setting - only a genuinely tz-aware value gets converted before
   * formatting (with either a field's own `displayFormat` pattern or
   * the global default pattern for its kind).
   */
  displayFormatTzAware?: boolean

  /**
   * `true` only for a real `json`/`jsonb` column - auto-derived and
   * persisted the same way as `displayFormatKind` above (never a
   * builder choice), because the runtime FORM has no other way to tell
   * "this column is JSON" - `DataViewField` carries no Postgres type of
   * its own, only `columnName`. Read by WidgetRenderer.vue's
   * own `isJsonTextareaFor` to swap in `WidgetJsonTextarea.vue` (a
   * JSON.stringify/parse wrapper) instead of the plain `UTextarea` a
   * jsonb value would otherwise render as the literal string
   * "[object Object]" against - covers
   * both Edit (value arrives as a real object) AND Create (value starts
   * `null`, so there's nothing in the runtime VALUE itself to detect
   * this from).
   */
  isJsonColumn?: boolean
  /** The column has a DEFAULT (auto-derived, like `isJsonColumn`): creating a record, an empty value is left to PostgreSQL even when the field is required - an edit still requires it. */
  dbDefault?: boolean

  /**
   * Advanced mode: arbitrary HTML attribute / Nuxt UI prop passthrough,
   * for anything not curated above - e.g. `maxlength` on a widget this
   * form doesn't otherwise expose it for, or a Nuxt UI prop added in a
   * later version. Always a string (a raw key/value editor can't express
   * other types safely) - `widgetProps()` (WidgetRenderer.vue)
   * binds it last, so a curated key above always wins on conflict rather
   * than a stray custom entry silently overriding it. Reserved names
   * (`RESERVED_ATTR_KEYS`) are stripped before saving - they'd otherwise
   * fight the widget's own v-model/event wiring.
   */
  htmlAttrs?: Record<string, string>

  // --- Grid-only display niceties (a follow-up to the display-format
  // feature) - none of these touch the FORM's live
  // widget at all, only how a cell reads in the read-only grid
  // (build-dataview-columns.ts). ---

  /** Shown instead of the grid's hardcoded "—" for a null/empty value on THIS field - e.g. "Unassigned", "N/A". Unset keeps today's "—". */
  emptyText?: string
  /** USwitch/UCheckbox only - custom text instead of the plain check/x icon in the grid, e.g. `{ true: 'Active', false: 'Inactive' }`. Unset keeps today's icon-only rendering; either side may be set alone (the other still falls back to its own icon). */
  booleanLabels?: { true?: string, false?: string }
  /** How a text cell fits its column - one line cut with "…" (default) or several lines (`GridCellConfig`, DataViews.md §4.3). Never touches the FORM. */
  textWrap?: GridCellConfig['textWrap']
  /** With `textWrap: 'wrap'`, at most this many lines. */
  maxLines?: number
  /** Where the cell's content sits in a taller row. */
  verticalAlign?: GridCellConfig['verticalAlign']
  /** The grid column's width and its bounds, in px - unset, as wide as its content up to GRID_COLUMN_DEFAULT_MAX_WIDTH. */
  width?: number
  minWidth?: number
  maxWidth?: number
  /** A small clipboard button next to this field's grid cell - offered for basically any widget (unlike `textWrap`/`linkType`), not just text-ish ones: copying a UUID/number/formatted date is just as common as copying a name. Copies the SAME text the cell shows (`formatCellPlainText`), not the raw underlying value. */
  copyable?: boolean
  /** Its total at the grid's foot (DataViews.md §4.9): sum, avg, min, max or count over every filtered row. */
  total?: 'sum' | 'avg' | 'min' | 'max' | 'count'
  /** UInput only, in practice - renders the plain text as a real clickable link instead of static text: `'url'` (opens in a new tab), `'email'` (`mailto:`), or `'tel'` (`tel:`). */
  linkType?: 'url' | 'email' | 'tel'

  // --- Binding v2 (after WaveMaker's own "Binding": https://docs.wavemaker.com/learn/how-tos/form-
  // conditional-flows/): any of the properties below can be driven by
  // the record's OTHER field values instead of a static one, via ONE
  // formula engine (utils/formula-engine.ts - jsep parses, a hand-
  // written evaluator there executes operators/`{{col}}` lookups, a
  // curated allowlist of `@formulajs/formulajs` functions covers
  // ROUND/CONCATENATE/IF/date-math/etc). Replaces the older two-engine
  // split (a plain `{{column}}` substitution for text, a separate
  // `_eq`/`_and`/`_or` condition tree for boolean) - retired outright
  // rather than kept alongside it (TotalBase has no production data to
  // migrate yet). `value` (types/dataview.ts's
  // `BindableKey`) is the one entry here with real runtime
  // consequences beyond "override a static default" - see
  // record-engine.ts's own doc comment on what it does.
  //
  // Falls back to the property's own static value whenever the
  // binding is unset, fails to parse, or references a column that
  // isn't there - a typo never surprises anyone by silently hiding
  // data or changing behavior (see `effectiveText`
  // below).
  bindings?: Partial<Record<BindableKey, string>>

  /**
   * Which DataView code function fires for which of this widget's own
   * events - e.g. `{ change: 'onEmailChange' }`.
   * Set by the Design form's Events tab (CustomDesigner.vue), never
   * hand-typed - the function name is generated and scaffolded into the
   * DataView's own `code` at the same time this is saved. Resolved by
   * name at runtime via useDataViewController.ts's `call()`, same
   * "resolve everything by name, no dynamic property discovery" approach
   * as the fixed lifecycle hooks.
   */
  events?: Partial<Record<string, string>>
}

/**
 * Text-ish properties offered for a formula binding - `label`/`visible`
 * (BooleanBindableKey below) live on `DataViewField` itself, not inside
 * `config`, but the binding for both still lives here alongside every
 * other one, keyed the same way its static counterpart is named.
 */
export type TextBindableKey = 'label' | 'placeholder' | 'defaultValue' | 'description' | 'hint' | 'patternMessage' | 'prefix' | 'suffix' | 'emptyText'
/** Flow-control properties offered for a formula binding. */
export type BooleanBindableKey = 'visible' | 'required' | 'disabled' | 'readonly' | 'autofocus'
/** Every key `config.bindings` accepts - `'value'` (COLUMN fields only) overrides the field's own live DATA, not a config default; see `record-engine.ts`'s own doc comment on its extra runtime consequences (auto-disable, dependency graph, grid-side computation). */
export type BindableKey = TextBindableKey | BooleanBindableKey | 'value'

/**
 * Attribute names `htmlAttrs` (the Advanced tab's free-form editor) can
 * never set - each one is already wired by the widget itself (v-model,
 * `class`, `disabled`, or a Vue-internal), so letting a custom entry
 * reuse it would silently fight that wiring instead of adding to it.
 * `onXxx` event handlers are blocked as a class, not name-by-name.
 */
export const RESERVED_ATTR_KEYS = new Set(['modelvalue', 'onupdate:modelvalue', 'class', 'style', 'key', 'ref', 'id', 'disabled'])
/** Applied in `sanitizeHtmlAttrs` - blocks any `onClick`/`onFocus`/etc, case-insensitively, in addition to the exact names above. */
export function isReservedAttrKey(key: string): boolean {
  const lower = key.trim().toLowerCase()
  return lower === '' || lower.startsWith('on') || RESERVED_ATTR_KEYS.has(lower)
}
/** One row of the designer's free-form HTML attribute editor (DesignerHtmlAttrsEditor.vue). */
export interface HtmlAttrRow { key: string, value: string }

/** Trims, drops reserved/empty names, and drops duplicates (last one wins) - shared by the Design form's Apply and anywhere else `htmlAttrs` gets written. */
export function sanitizeHtmlAttrs(pairs: { key: string, value: string }[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { key, value } of pairs) {
    const trimmed = key.trim()
    if (!trimmed || isReservedAttrKey(trimmed)) continue
    result[trimmed] = value
  }
  return result
}

/**
 * Which FieldConfig keys the inspector should offer for a given widget -
 * e.g. `min`/`max`/`step` only make sense for UInputNumber,
 * `options`/`multiple` only for a non-FK select. Keeps the
 * inspector from showing a `pattern` box on a UInputTags field just
 * because the base set covers most widgets.
 */
export type FieldConfigKey = keyof Omit<FieldConfig, 'label' | 'help' | 'display_field' | 'display_template' | 'display_field_target' | 'display_inherited' | 'display_field_denied' | 'htmlAttrs' | 'description' | 'hint' | 'orientation' | 'displayFormatKind' | 'displayFormatTzAware' | 'bindings' | 'events'>

export const BOOLEAN_WIDGETS = new Set<string>(['USwitch', 'UCheckbox'])
export const NUMERIC_WIDGETS = new Set<string>(['UInputNumber', 'USlider', 'UInputRating'])

// Every widget understands these - a Nuxt UI `size`/`icon`, standard HTML
// focus/autofill/a11y attributes - so unlike the widget-specific keys
// below (min/max, options...) they're never gated by `switch (widget)`.
// `displayFormat` lives here, not in a widget's own `case` below - it's
// gated by the COLUMN's real type (isNumericColumnFor/temporalKindFor,
// CustomDesigner.vue), never by which widget is selected (see
// field-config.ts's own doc comment on why - the whole point of this
// correction). The inspector's own template still decides whether to
// actually show the control; this only needs to not zero it out on save.
const BASE_KEYS: FieldConfigKey[] = [
  'placeholder', 'required', 'disabled', 'readonly', 'defaultValue',
  'size', 'icon', 'autofocus', 'autocomplete', 'tabindex', 'ariaLabel', 'cssClass', 'displayFormat',
  // Grid-only display niceties - never gated by widget, same reasoning
  // as `displayFormat` just above (booleanLabels is the one exception,
  // deleted back out for every widget except USwitch/UCheckbox below;
  // linkType is offered per-widget below instead of here, UInput-only).
  'emptyText', 'textWrap', 'maxLines', 'booleanLabels', 'copyable', 'total'
]

/** A cell's text fit is for text - a widget whose cell never is long text drops both. */
function dropTextWrap(keys: Set<FieldConfigKey>) {
  keys.delete('textWrap')
  keys.delete('maxLines')
}

export function applicableConfigKeys(widget: WidgetName | string, isForeignKey: boolean): Set<FieldConfigKey> {
  const keys = new Set<FieldConfigKey>(BASE_KEYS)
  // `booleanLabels` only ever makes sense for the two widgets whose
  // grid cell is otherwise a bare check/x icon - deleted back out for
  // everything else right here, once, instead of at every other case
  // below.
  if (widget !== 'USwitch' && widget !== 'UCheckbox') keys.delete('booleanLabels')
  switch (widget) {
    case 'UInput':
      keys.add('minLength').add('maxLength').add('pattern').add('patternMessage').add('prefix').add('suffix').add('inputType').add('linkType')
      break
    case 'UTextarea':
      keys.add('minLength').add('maxLength').add('pattern').add('patternMessage')
      break
    case 'UInputNumber':
      keys.add('min').add('max').add('step').add('decimals').add('prefix').add('suffix')
      dropTextWrap(keys)
      break
    case 'USelect':
    case 'USelectMenu':
      if (!isForeignKey) keys.add('options').add('multiple')
      break
    case 'USwitch':
    case 'UCheckbox':
      // A toggle has no placeholder text, and its grid cell is never long text.
      keys.delete('placeholder')
      dropTextWrap(keys)
      break
    case 'UInputTags':
      // No default value for tags in this pass - it'd need its own tag-list
      // editor rather than a plain text/number/boolean input like the rest.
      keys.delete('defaultValue')
      break
    case 'UInputMenu':
    case 'UListbox':
      if (!isForeignKey) keys.add('options').add('multiple')
      keys.delete('placeholder')
      break
    case 'URadioGroup':
      keys.add('options').delete('placeholder')
      break
    case 'UCheckboxGroup':
      // Always multi-select - no `multiple` toggle, and no single default
      // value (same reasoning as UInputTags just above).
      keys.add('options').delete('placeholder')
      keys.delete('defaultValue')
      break
    case 'UInputRating':
      keys.add('ratingLength').delete('placeholder')
      dropTextWrap(keys)
      break
    case 'UPinInput':
      keys.add('pinLength').delete('placeholder')
      dropTextWrap(keys)
      break
    case 'USlider':
      keys.add('min').add('max').add('step').delete('placeholder')
      dropTextWrap(keys)
      break
    case 'UInputDate':
    case 'UInputTime':
      keys.delete('placeholder')
      dropTextWrap(keys)
      break
    case 'UFileUpload':
    case 'TCamera':
    case 'TSignature':
      // No placeholder text, and no meaningful "default value" for a
      // file that hasn't been uploaded yet - unlike every other widget,
      // there's nothing to type into a config box that would become
      // the field's starting value.
      keys.delete('placeholder')
      keys.delete('defaultValue')
      dropTextWrap(keys)
      keys.delete('copyable')
      break
    case 'TJson':
      // Same reasoning as UFileUpload just above - the value is a real
      // object/array, not text, so there's no plain-text "default
      // value"/placeholder/wrap/copy-icon config that would
      // mean anything here. Property-level editing lives entirely
      // inside WidgetJson.vue's own Simple/Advanced UI, not the
      // inspector's generic config keys.
      keys.delete('placeholder')
      keys.delete('defaultValue')
      dropTextWrap(keys)
      keys.delete('copyable')
      break
    case 'TScanner':
      // Its text field is read by a reader or Enter - no placeholder (a help label explains it, AGENTS.md section 25).
      keys.delete('placeholder')
      break
    case 'TPasswordInput':
      // A secret, never read: no starting value, no example in the field, nothing to copy.
      keys.delete('placeholder')
      keys.delete('defaultValue')
      dropTextWrap(keys)
      keys.delete('copyable')
      break
    case 'TUuidInput':
    case 'TUlidInput':
      // An id on one line, generated by its icon - no wrapping, no placeholder (a help label explains it).
      keys.delete('placeholder')
      dropTextWrap(keys)
      break
    case 'TColorSelect':
      // A swatch button, not a text input - no placeholder text, and
      // its grid cell is never long text either. `defaultValue`/
      // `copyable` stay - a builder can still set a starting color
      // (a plain name or hex string) for new records, and copying the
      // raw stored value is just as meaningful as for any other widget.
      keys.delete('placeholder')
      dropTextWrap(keys)
      break
    case 'UEditor':
      // Same reasoning as TJson just above - the value is rich content
      // (markdown/HTML source, or a JSON document for Blocks), not
      // plain text, so there's no plain-text "default value"/
      // placeholder/wrap/copy-icon config that would mean
      // anything here.
      keys.add('editorContentType')
      keys.delete('placeholder')
      keys.delete('defaultValue')
      dropTextWrap(keys)
      keys.delete('copyable')
      break
  }
  return keys
}

export interface ColumnConstraints {
  /** NOT NULL - when true, "Required" is forced on and locked in the inspector. */
  notNull: boolean
  /** GENERATED ALWAYS AS IDENTITY - the DB assigns the value, so the field is locked fully disabled. */
  isIdentity: boolean
  /** A generated/computed column - same lock as identity. */
  isGenerated: boolean
  /** The column has a DEFAULT - a new record may leave it empty, PostgreSQL fills it in (`config.dbDefault`). */
  hasDefault: boolean
  /** Primary key or the sole column of a UNIQUE constraint - shown as an informational badge, never an editable switch. */
  isUnique: boolean
  isPrimaryKey: boolean
}

/**
 * Reads NOT NULL/identity/generated/unique straight off the already-loaded
 * `RelationDetail` (the Design form fetches it for widget-compatibility
 * anyway) - no extra request, and no attempt to parse CHECK constraint
 * expressions for a `pattern`/enum: that's arbitrary SQL, fragile to
 * infer safely, and left as a manual field (same call widget-compatibility.
 * ts already made for detecting real enums).
 */
export function columnConstraintsFor(relationDetail: RelationDetail | null, columnName: string | null): ColumnConstraints {
  const column = relationDetail?.columns.find(c => c.name === columnName)
  const isPrimaryKey = Boolean(columnName) && (relationDetail?.primaryKey.includes(columnName!) ?? false)
  const isUnique = isPrimaryKey
    || (Boolean(columnName) && (relationDetail?.uniqueConstraints.some(cols => cols.length === 1 && cols[0] === columnName) ?? false))
  return {
    notNull: column ? !column.nullable : false,
    isIdentity: column?.isIdentity ?? false,
    isGenerated: column?.isGenerated ?? false,
    hasDefault: column ? column.defaultExpression !== null : false,
    isUnique,
    isPrimaryKey
  }
}

/**
 * The effective value of a text-bindable property for ONE record - the
 * formula's own result (utils/formula-engine.ts) when `bindings[key]`
 * is set and evaluates cleanly to something non-empty, otherwise
 * `staticValue` untouched (the property's own plain config value, or
 * the caller's own default). Shared by the grid (label doesn't apply
 * there, but emptyText does) and the record form (every other key) so
 * neither re-derives this on its own.
 *
 * No `columnKinds`/timezone threaded through here - a text-typed
 * binding rarely needs real date ARITHMETIC (that's `value` bindings'
 * job, wired with full column metadata in record-engine.ts);
 * a `date`/`time`/`datetime` column referenced here just reads as its
 * raw stored string, which still compares/interpolates correctly for
 * the common case (`yyyy-MM-dd` sorts and prints fine as plain text)
 * even without boxing.
 */
export function effectiveText(config: FieldConfig, key: TextBindableKey, staticValue: string, values: Record<string, unknown>): string {
  const formula = config.bindings?.[key]
  if (!formula) return staticValue
  const result = evaluateFormula(formula, { values, returnType: 'string' })
  return result.ok && result.value ? String(result.value) : staticValue
}

/**
 * A `value` binding's own expected result type, inferred from the
 * TARGET column - same "the destination decides the type" rule every
 * other binding target already follows (utils/formula-engine.ts's own
 * `FormulaReturnType` doc comment). Temporal columns win outright
 * (their `displayFormatKind`); otherwise the WIDGET says whether this
 * is a boolean/numeric/plain-text column - reuses the exact widget
 * sets the grid's formats key off. Used by the grid
 * (build-dataview-columns.ts) for a computed column.
 */
export function formulaReturnTypeFor(field: { widget: string | null, config: unknown }): FormulaReturnType {
  const config = field.config as FieldConfig
  const kind = config.displayFormatKind
  if (kind === 'date' || kind === 'time' || kind === 'datetime') return kind
  if (BOOLEAN_WIDGETS.has(field.widget ?? '')) return 'boolean'
  if (NUMERIC_WIDGETS.has(field.widget ?? '')) return 'number'
  return 'string'
}
