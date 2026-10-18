<script setup lang="ts">
/**
 * The small icon next to a bindable property's label (CustomDesigner.
 * vue's Bindings doc comment) - solid/primary when a binding is active,
 * ghost/neutral otherwise - a glance at any tab already shows which
 * properties are "secretly" overridden.
 *
 * A real modal with ONE left
 * sidebar (Fields + Functions + Format, stacked sections - the SAME
 * layout shape the Design form's own palette already uses, not a
 * bespoke one) and `FormulaEditor.vue` (Monaco) taking the rest of the
 * width - chosen over splitting fields/functions across two side panels
 * specifically so the editor itself keeps real room to be readable (the
 * chat's own reasoning: a formula editor benefits from width far more
 * than a canvas mockup does, live autocomplete already covers most of
 * what a second sidebar would).
 *
 * Clicking a Field/Function/Format button inserts through
 * `FormulaEditor.vue`'s own exposed `insertAtCursor` (a real Monaco
 * edit at the current selection/cursor - that component's own doc
 * comment on why this couldn't just append to `draft` from out here).
 * Functions insert a full example call (`FORMULA_FUNCTION_INSERT_
 * TEMPLATES`, e.g. `CONCATENATE("val1", "val2", "valN")`), not a bare
 * `NAME(` - `insertAtCursor` also auto-selects that first `"val1"`
 * placeholder, so clicking a Field/Format button right after replaces
 * it directly, no manual select-with-the-mouse step needed first (the
 * chat's own worked example).
 */
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition, RelationDetail } from '~/types/schema'
import { evaluateFormula, FORMAT_FUNCTION_NAMES, FORMULA_FUNCTION_INSERT_TEMPLATES, FORMULA_FUNCTION_SIGNATURES, type FormulaRichSegment } from '~/utils/formula-engine'
import { renderRichTextHtml } from '~/utils/rich-text-render'
// Explicit import (unlike every other component here, otherwise all
// auto-imported) - `InstanceType<typeof FormulaEditor>` below needs the
// real symbol in scope; Nuxt's auto-import only registers the component
// for TEMPLATE usage, not as a type-level value.
import FormulaEditor from '~/components/FormulaEditor.vue'

const value = defineModel<string>({ default: '' })
const props = defineProps<{
  kind: 'text' | 'boolean' | 'value'
  /** The property's own label (e.g. "Placeholder", "Required") - the modal's own title, and this button's `aria-label`/tooltip, so it's clear which of many on the same tab this one is. */
  label: string
  /** Sibling column names to offer in the sidebar's own "Fields" section. */
  columns?: CatalogColumn[]
  /**
   * The source table's own FK relations (`RelationDetail.relations`,
   * the SAME fetch every caller already makes for its own Design form/
   * settings page) - lets a Fields row for a Foreign Key column expand
   * into a submenu of ITS OWN related table's columns
   * (`{{customer.name}}`, `{{customer.email}}`, ...), one hop only
   * (formula-engine.ts's own `TEMPLATE_TOKEN` doc comment on why).
   * Omitted entirely (a caller that hasn't wired this yet) just means no
   * column here ever shows as expandable - same as before this existed.
   */
  relations?: RelationDefinition[]
  /** A DB-derived lock (e.g. Required's own NOT NULL) already forces this property's static value and can't be overridden by ANY binding either - disables the trigger entirely rather than letting a binding quietly defeat a lock shown as disabled right next to it. */
  disabled?: boolean
  /** Tooltip shown while `disabled` - falls back to a generic message when the caller doesn't pass one. */
  disabledReason?: string
  /** Sits beside an input (the widget inspector): the input's size and outlined, like the other buttons next to inputs - not a small ghost icon. */
  besideInput?: boolean
}>()

// --- Relation column picker (Fields section) - lazy per FK column, the
// first time it's actually expanded (most Bind modals never touch this
// at all - fetching every relation's own columns up front would be
// wasted work almost every time). `useResourcesList()` is shared/deduped
// across every BindingButton on the same page (its own doc comment) -
// a Design form page mounts one instance per bindable property, and
// nothing here should turn that into one `/resources` request each.
const adminApi = useAdminApi()
const { resources } = useResourcesList()
function relationFor(columnName: string): RelationDefinition | undefined {
  return props.relations?.find(r => r.sourceColumn === columnName)
}
const expandedRelations = ref<Set<string>>(new Set())
const relatedColumns = ref<Record<string, CatalogColumn[] | 'loading' | 'error'>>({})
async function toggleRelation(columnName: string) {
  const next = new Set(expandedRelations.value)
  if (next.has(columnName)) {
    next.delete(columnName)
    expandedRelations.value = next
    return
  }
  next.add(columnName)
  expandedRelations.value = next
  if (relatedColumns.value[columnName]) return // already fetched (or in flight) - don't refetch on every re-expand
  const relation = relationFor(columnName)
  const target = relation ? resources.value.find(r => r.schema === relation.targetSchema && r.name === relation.targetTable) : undefined
  if (!relation || !target) {
    relatedColumns.value = { ...relatedColumns.value, [columnName]: 'error' }
    return
  }
  relatedColumns.value = { ...relatedColumns.value, [columnName]: 'loading' }
  try {
    const kind = target.type === 'VIEW' ? 'view' : 'table'
    const { data } = await adminApi.get<RelationDetail>(`/catalog/${kind}/${target.postgresOid}`)
    relatedColumns.value = { ...relatedColumns.value, [columnName]: data.columns }
  } catch {
    relatedColumns.value = { ...relatedColumns.value, [columnName]: 'error' }
  }
}
/** Inserts the one-hop relation token (`{{customer.name}}`) - formula-engine.ts's own `TEMPLATE_TOKEN`/`parseRelationFieldRefs` doc comments are the other half of this contract (what actually resolves it at evaluation time). */
function insertRelationField(columnName: string, relatedColumnName: string) {
  insertText(`{{${columnName}.${relatedColumnName}}}`)
}

const open = ref(false)
const bound = computed(() => Boolean(value.value?.trim()))
// A local draft so Cancel/closing the modal without an explicit Apply
// never commits a half-typed edit - `value` (the actual v-model, saved
// on Apply) only changes when the builder says so, same discipline the
// Design form's OWN inspector uses for everything else (draft refs,
// flushed on a real action, never on every keystroke's raw text).
const draft = ref('')
watch(open, (isOpen) => {
  if (isOpen) draft.value = value.value ?? ''
})

const placeholderExample = computed(() => {
  if (props.kind === 'boolean') return '{{cantidad}} * {{precio}} > 500'
  if (props.kind === 'value') return '{{cantidad}} * {{precio}}'
  return '{{status}} == "late" ? "Vencido" : {{status}}'
})

const functionEntries = computed(() => Object.entries(FORMULA_FUNCTION_SIGNATURES).filter(([name]) => !FORMAT_FUNCTION_NAMES.has(name)))
/** BOLD/ITALIC/.../NEW_LINE - a separate sidebar section, `kind="text"` only (Visible/Disabled/`value` bindings never render their result as markup, so styling functions there would just silently vanish into the plain-text fallback - `FORMULA_FUNCTION_INSERT_TEMPLATES`'s own doc comment on `.rich`). */
const formatEntries = computed(() => props.kind === 'text' ? Object.entries(FORMULA_FUNCTION_SIGNATURES).filter(([name]) => FORMAT_FUNCTION_NAMES.has(name)) : [])

/** The footer's "Examples" popover - one row per common shape, spanning the return-type kinds a binding can target - type/syntax/value columns. */
/**
 * ONE shared, fixed sample "record" every example below evaluates
 * against - a single coherent context (English
 * field names, matching every OTHER field name this app's own docs/
 * examples use) beats hand-typing a plausible-sounding result per row.
 * `SAMPLE_COLUMN_KINDS` boxes the three date fields as real `Date`s
 * (`evaluateFormula`'s own `columnKinds` option) so date arithmetic/
 * EDATE/YEAR/etc. behave exactly as they would against a real date
 * column - unboxed back to `yyyy-MM-dd` strings in the Result column
 * only when a formula's own result is ALSO a date (`DATE(...)`/EDATE`/
 * plain `+`/`-` arithmetic) via `dateReturnHint` below; every other
 * function (YEAR, DATEDIF, ...) returns a plain number/string already.
 */
const SAMPLE_VALUES: Record<string, unknown> = {
  quantity: 5,
  price: 30,
  discount: 10,
  status: 'active',
  notes: '',
  total: 149.955,
  diff: -25,
  first_name: 'John',
  last_name: 'Doe',
  name: 'John Doe',
  email: 'john@example.com',
  phone: '555-1234',
  code: 'ABC123',
  profile_url: 'https://example.com/u/1',
  start_date: '2026-09-13',
  end_date: '2026-10-28'
}
const SAMPLE_COLUMN_KINDS: Record<string, 'date'> = { start_date: 'date', end_date: 'date' }
/** Bare arithmetic (`+`/`-`) and `EDATE`/`DATE` return a real `Date` - hinting `returnType: 'date'` for just these rows gets a readable `yyyy-MM-dd` in the Result column instead of a full ISO instant (`coerceResult`'s own no-`returnType` branch). Every other date function (YEAR/MONTH/DAY/DATEDIF/TODAY/NOW) already returns a plain number/string on its own. */
const DATE_RESULT_SYNTAX = new Set(['{{start_date}} + 30', 'EDATE({{start_date}}, 1)', 'DATE(2026, 12, 25)'])

const FORMULA_EXAMPLES: { type: string, syntax: string }[] = [
  { type: 'boolean', syntax: '{{quantity}} > 0' },
  { type: 'boolean', syntax: '{{status}} == "active"' },
  { type: 'boolean', syntax: 'AND({{quantity}} > 0, {{price}} > 0)' },
  { type: 'boolean', syntax: 'OR({{status}} == "late", {{status}} == "overdue")' },
  { type: 'boolean', syntax: 'NOT({{status}} == "active")' },
  { type: 'boolean', syntax: 'ISBLANK({{notes}})' },
  { type: 'boolean', syntax: 'ISNUMBER({{quantity}})' },
  { type: 'boolean', syntax: 'ISTEXT({{name}})' },
  { type: 'date', syntax: '{{start_date}} + 30' },
  { type: 'date', syntax: '{{end_date}} - {{start_date}}' },
  { type: 'date', syntax: 'EDATE({{start_date}}, 1)' },
  { type: 'date', syntax: 'YEAR({{start_date}})' },
  { type: 'date', syntax: 'MONTH({{start_date}})' },
  { type: 'date', syntax: 'DAY({{start_date}})' },
  { type: 'date', syntax: 'DATEDIF({{start_date}}, {{end_date}}, "d")' },
  { type: 'date', syntax: 'DATE(2026, 12, 25)' },
  { type: 'date', syntax: 'TODAY()' },
  { type: 'date', syntax: 'NOW()' },
  { type: 'numeric', syntax: '{{quantity}} * {{price}}' },
  { type: 'numeric', syntax: 'ROUND({{total}}, 2)' },
  { type: 'numeric', syntax: 'FORMAT_NUMBER({{total}}, 2)' },
  { type: 'numeric', syntax: 'CURRENCY({{total}}, "ARS")' },
  { type: 'date', syntax: 'FORMAT_DATE({{start_date}}, "dd/MM/yyyy")' },
  { type: 'numeric', syntax: 'ROUNDUP({{total}}, 1)' },
  { type: 'numeric', syntax: 'ROUNDDOWN({{total}}, 1)' },
  { type: 'numeric', syntax: '{{price}} - {{discount}}' },
  { type: 'numeric', syntax: 'MOD({{quantity}}, 2)' },
  { type: 'numeric', syntax: 'ABS({{diff}})' },
  { type: 'numeric', syntax: 'SUM({{price}}, {{discount}}, {{quantity}})' },
  { type: 'numeric', syntax: 'MIN({{price}}, {{discount}})' },
  { type: 'numeric', syntax: 'MAX({{price}}, {{discount}})' },
  { type: 'numeric', syntax: 'AVERAGE({{price}}, {{discount}}, {{quantity}})' },
  { type: 'numeric', syntax: 'PRODUCT({{quantity}}, {{price}})' },
  { type: 'numeric', syntax: 'POWER({{quantity}}, 2)' },
  { type: 'numeric', syntax: 'SQRT({{quantity}})' },
  { type: 'text', syntax: 'IF({{status}} == "late", "Vencido", "Al día")' },
  { type: 'text', syntax: 'IFS({{quantity}} == 0, "None", {{quantity}} < 10, "Few", true, "Many")' },
  { type: 'text', syntax: 'CONCATENATE({{first_name}}, " ", {{last_name}})' },
  { type: 'text', syntax: 'CONCATENATE("Email: ", {{email}}, "   Phone: ", {{phone}})' },
  { type: 'text', syntax: 'UPPER({{status}})' },
  { type: 'text', syntax: 'LOWER({{status}})' },
  { type: 'text', syntax: '{{status}} == "late" ? "Vencido" : "Al día"' },
  { type: 'text', syntax: 'TRIM({{name}})' },
  { type: 'text', syntax: 'LEN({{name}})' },
  { type: 'text', syntax: 'LEFT({{code}}, 3)' },
  { type: 'text', syntax: 'RIGHT({{code}}, 3)' },
  { type: 'text', syntax: 'MID({{code}}, 2, 3)' },
  { type: 'text', syntax: 'SUBSTITUTE({{phone}}, "-", " ")' },
  { type: 'format', syntax: 'BOLD("Email: ") + {{email}}' },
  { type: 'format', syntax: 'ITALIC({{status}})' },
  { type: 'format', syntax: 'UNDERLINE({{name}})' },
  { type: 'format', syntax: 'STRIKETHROUGH("$" + {{price}})' },
  { type: 'format', syntax: 'COLOR({{status}}, "blue")' },
  { type: 'format', syntax: 'BADGE({{status}}, "green")' },
  { type: 'format', syntax: 'LINK({{name}}, {{profile_url}}, "_blank")' },
  { type: 'format', syntax: 'CONCATENATE(ICON("i-lucide-mail"), " ", {{email}})' },
  { type: 'format', syntax: 'CONCATENATE(BOLD("Email: "), {{email}}, NEW_LINE(), "Phone: ", {{phone}})' }
]
/** Section order for the Examples modal below - same grouping as the sidebar (Fields aside, which has no examples of its own - a bare `{{column}}` needs none). */
const EXAMPLE_TYPE_ORDER = ['boolean', 'date', 'numeric', 'text', 'format']
const { t } = useI18n()
const EXAMPLE_TYPE_LABEL_KEYS: Record<string, string> = {
  boolean: 'designer.bindingButton.types.boolean',
  date: 'designer.bindingButton.types.date',
  numeric: 'designer.bindingButton.types.numeric',
  text: 'designer.bindingButton.types.text',
  format: 'designer.bindingButton.types.format'
}

/**
 * The Result column's own text - the REAL computed value (`evaluateFormula`
 * against `SAMPLE_VALUES` above), not hand-typed prose. Self-verifying:
 * if a future engine change ever breaks one of these examples, its
 * Result cell changes (or shows the real error) right along with it,
 * instead of a stale description quietly going wrong. Sync (no network) -
 * safe to compute eagerly for the whole list.
 */
const exampleResults = computed(() => {
  const map = new Map<string, { text: string, rich?: FormulaRichSegment[] }>()
  for (const example of FORMULA_EXAMPLES) {
    const result = evaluateFormula(example.syntax, {
      values: SAMPLE_VALUES,
      columnKinds: SAMPLE_COLUMN_KINDS,
      returnType: DATE_RESULT_SYNTAX.has(example.syntax) ? 'date' : undefined
    })
    map.set(example.syntax, result.ok ? { text: String(result.value ?? ''), rich: result.rich } : { text: t('designer.bindingButton.errorResult', { error: result.error }) })
  }
  return map
})
/**
 * A FORMAT example's Result renders the REAL styled preview (bold text,
 * an actual badge chip, a real link, the real mail icon) via the exact
 * same `renderRichTextHtml` the Map popup uses - chosen over a
 * plain-text description. Async ONLY because of `ICON()` (one
 * network round trip, module-cached - `rich-text-render.ts`'s own doc
 * comment); populated lazily the first time the modal actually opens,
 * not at this button's own mount, since most Bind buttons on a page
 * never get their Examples modal opened at all.
 */
const examplesOpen = ref(false)
const exampleResultHtml = ref<Record<string, string>>({})
let exampleResultHtmlLoaded = false
watch(examplesOpen, async (isOpen) => {
  if (!isOpen || exampleResultHtmlLoaded) return
  exampleResultHtmlLoaded = true
  for (const [syntax, result] of exampleResults.value) {
    if (result.rich) exampleResultHtml.value[syntax] = await renderRichTextHtml(result.rich)
  }
})

/** Collapsed by default - most visits don't need it, but the Result column's own numbers/text mean nothing without knowing where they came from. */
const showSampleValues = ref(false)
const sampleValueEntries = Object.entries(SAMPLE_VALUES)
const exampleSearch = ref('')
const groupedExamples = computed(() => {
  const search = exampleSearch.value.trim().toLowerCase()
  const filtered = search
    ? FORMULA_EXAMPLES.filter(e => e.syntax.toLowerCase().includes(search) || (exampleResults.value.get(e.syntax)?.text.toLowerCase().includes(search)) || e.type.includes(search))
    : FORMULA_EXAMPLES
  return EXAMPLE_TYPE_ORDER
    .map(type => ({ type, label: t(EXAMPLE_TYPE_LABEL_KEYS[type]!), rows: filtered.filter(e => e.type === type) }))
    .filter(group => group.rows.length > 0)
})
function insertExample(syntax: string) {
  insertText(syntax)
  examplesOpen.value = false
}

/** See this file's own top doc comment on why this goes through the editor's real Monaco selection, not a plain string append. `formulaEditorRef` is only set once `FormulaEditor.vue` itself has mounted - `draft` append is the fallback for the brief window before that (matches the OLD behavior exactly, so nothing regresses if a click somehow lands before Monaco's ready). */
const formulaEditorRef = ref<InstanceType<typeof FormulaEditor> | null>(null)
function insertText(text: string) {
  if (formulaEditorRef.value) formulaEditorRef.value.insertAtCursor(text)
  else draft.value = `${draft.value}${text}`
}
/** Functions/Format buttons insert a full example call (`CONCATENATE("val1", "val2", "valN")`), not the bare `NAME(` the old behavior used - `FORMULA_FUNCTION_INSERT_TEMPLATES`'s own doc comment. */
function insertFunction(name: string) {
  insertText(FORMULA_FUNCTION_INSERT_TEMPLATES[name] ?? `${name}(`)
}

function apply() {
  value.value = draft.value.trim()
  open.value = false
}
function clear() {
  value.value = ''
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UTooltip :text="disabled ? (disabledReason ?? t('designer.bindingButton.cannotBind', { label })) : bound ? t('designer.bindingButton.boundTooltip', { label }) : t('designer.bindingButton.unboundTooltip', { label })">
    <UButton
      icon="i-lucide-link"
      :size="besideInput ? undefined : 'xs'"
      :color="bound ? 'primary' : 'neutral'"
      :variant="bound ? 'subtle' : besideInput ? 'outline' : 'ghost'"
      square
      :disabled="disabled"
      :aria-label="t('designer.bindingButton.bindLabel', { label })"
      @click="open = true"
    />
  </UTooltip>

  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="t('designer.bindingButton.bindLabel', { label })"
    :description="t('designer.bindingButton.modalDescription', { label })"
    :ui="{ content: isCompact ? undefined : 'max-w-5xl' }"
  >
    <template #body>
      <div class="grid grid-cols-1 gap-4 sm:h-[28rem] sm:grid-cols-[180px_1fr]">
        <div class="flex flex-col gap-3 overflow-y-auto">
          <div v-if="columns?.length">
            <p class="mb-1 text-xs font-medium uppercase text-muted">
              {{ t('designer.bindingButton.fields') }}
            </p>
            <div class="flex flex-col gap-0.5">
              <template
                v-for="c in columns"
                :key="c.name"
              >
                <div class="flex items-center">
                  <UButton
                    :label="c.name"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    block
                    class="justify-start font-mono"
                    @click="insertText(`{{${c.name}}}`)"
                  />
                  <!-- FK columns only (`relationFor`) - expands into that
                  related table's own columns, one hop, for `{{col.related}}`
                  (this file's own top doc comment on `relations`). -->
                  <UButton
                    v-if="relationFor(c.name)"
                    :icon="expandedRelations.has(c.name) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    square
                    :aria-label="t(expandedRelations.has(c.name) ? 'designer.bindingButton.collapseRelated' : 'designer.bindingButton.expandRelated', { column: c.name })"
                    @click="toggleRelation(c.name)"
                  />
                </div>
                <div
                  v-if="expandedRelations.has(c.name)"
                  class="ml-2.5 flex flex-col gap-0.5 border-l border-default pl-1.5"
                >
                  <p
                    v-if="relatedColumns[c.name] === 'loading'"
                    class="px-1.5 py-1 text-xs text-muted"
                  >
                    {{ t('common.loading') }}
                  </p>
                  <p
                    v-else-if="relatedColumns[c.name] === 'error' || !relatedColumns[c.name]"
                    class="px-1.5 py-1 text-xs text-muted"
                  >
                    {{ t('designer.bindingButton.loadColumnsError') }}
                  </p>
                  <template v-else>
                    <UButton
                      v-for="rc in (relatedColumns[c.name] as CatalogColumn[])"
                      :key="rc.name"
                      :label="rc.name"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      block
                      class="justify-start font-mono"
                      @click="insertRelationField(c.name, rc.name)"
                    />
                  </template>
                </div>
              </template>
            </div>
          </div>
          <div>
            <p class="mb-1 text-xs font-medium uppercase text-muted">
              {{ t('designer.bindingButton.functions') }}
            </p>
            <div class="flex flex-col gap-0.5">
              <UTooltip
                v-for="[name, signature] in functionEntries"
                :key="name"
                :text="signature"
              >
                <UButton
                  :label="name"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  block
                  class="justify-start font-mono"
                  @click="insertFunction(name)"
                />
              </UTooltip>
            </div>
          </div>
          <div v-if="formatEntries.length">
            <p class="mb-1 text-xs font-medium uppercase text-muted">
              {{ t('designer.bindingButton.format') }}
            </p>
            <div class="flex flex-col gap-0.5">
              <UTooltip
                v-for="[name, signature] in formatEntries"
                :key="name"
                :text="name === 'ICON' ? t('designer.bindingButton.iconHint', { signature }) : signature"
              >
                <UButton
                  :label="name"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  block
                  class="justify-start font-mono"
                  @click="insertFunction(name)"
                />
              </UTooltip>
            </div>
          </div>
        </div>

        <!-- A phone stacks the two columns: the formula first, with a height
        of its own (the grid has none there), the reference list below it. -->
        <div class="flex h-full flex-col gap-2 max-sm:order-first max-sm:h-56">
          <FormulaEditor
            ref="formulaEditorRef"
            v-model="draft"
            :columns="columns"
            class="min-h-0 flex-1"
          />
          <p class="text-xs text-muted">
            {{ t('designer.bindingButton.exampleHint') }} <code class="font-mono">{{ placeholderExample }}</code>
          </p>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <UButton
            :label="t('designer.bindingButton.examples')"
            icon="i-lucide-book-open"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="examplesOpen = true"
          />
        </div>
        <div class="flex gap-2">
          <UButton
            v-if="bound"
            :label="t('designer.bindingButton.removeBinding')"
            icon="i-lucide-x"
            color="error"
            variant="ghost"
            @click="clear"
          />
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="open = false"
          />
          <UButton
            :label="t('common.apply')"
            @click="apply"
          />
        </div>
      </div>
    </template>
  </UModal>

  <!-- A separate UModal (not the old cramped popover) - needed once
  the list passed 25 rows: grouped by section (same order as
  the sidebar), with a search box, in a much taller/wider surface. Stays
  on TOP of the Bind modal rather than replacing its content, so
  `formulaEditorRef` (still mounted underneath) is exactly what
  `insertExample` inserts into. -->
  <UModal
    v-model:open="examplesOpen"
    :fullscreen="isCompact"
    :title="t('designer.bindingButton.examplesTitle')"
    :description="t('designer.bindingButton.examplesDescription')"
    :ui="{ content: isCompact ? undefined : 'max-w-4xl' }"
  >
    <template #body>
      <div class="flex h-[28rem] flex-col gap-3">
        <UInput
          v-model="exampleSearch"
          :aria-label="t('designer.bindingButton.searchExamples')"
          icon="i-lucide-search"
          :placeholder="t('designer.bindingButton.searchExamples')"
          autofocus
        />
        <div>
          <UButton
            :icon="showSampleValues ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            :label="t('designer.bindingButton.sampleRecord')"
            size="xs"
            color="neutral"
            variant="ghost"
            class="px-0"
            @click="showSampleValues = !showSampleValues"
          />
          <div
            v-if="showSampleValues"
            class="mt-1 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-default bg-elevated p-2 font-mono text-xs text-muted"
          >
            <span
              v-for="[key, val] in sampleValueEntries"
              :key="key"
            >{{ key }}: <span class="text-highlighted">{{ JSON.stringify(val) }}</span></span>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div
            v-for="group in groupedExamples"
            :key="group.type"
            class="mb-4"
          >
            <p class="mb-1 text-xs font-medium uppercase text-muted">
              {{ group.label }}
            </p>
            <!-- A help list (syntax -> its result on the sample record), not data: rows of a grid, not a table. -->
            <div class="text-xs">
              <div
                v-for="(example, i) in group.rows"
                :key="i"
                class="grid grid-cols-[3fr_2fr] gap-2 border-t border-default py-1.5"
              >
                <div class="min-w-0 break-words">
                  <button
                    type="button"
                    class="rounded text-left font-mono text-highlighted transition-colors hover:text-primary"
                    @click="insertExample(example.syntax)"
                  >
                    {{ example.syntax }}
                  </button>
                </div>
                <div class="min-w-0 break-words font-mono text-muted">
                  <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
                  <span
                    v-if="exampleResultHtml[example.syntax]"
                    v-html="exampleResultHtml[example.syntax]"
                  />
                  <!-- eslint-enable vue/no-v-html -->
                  <span v-else>{{ exampleResults.get(example.syntax)?.text }}</span>
                </div>
              </div>
            </div>
          </div>
          <p
            v-if="groupedExamples.length === 0"
            class="py-6 text-center text-sm text-muted"
          >
            {{ t('designer.bindingButton.noMatch', { search: exampleSearch }) }}
          </p>
        </div>
      </div>
    </template>
  </UModal>
</template>
