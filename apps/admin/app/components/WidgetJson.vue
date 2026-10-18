<script setup lang="ts">
/**
 * `UJson` - the real, pickable Control for a `json`/`jsonb` COLUMN field
 * (Design form's "Control" dropdown, same rank as UInput/UTextarea/etc.,
 * not an automatic override like WidgetFormattedDate). Deliberately
 * independent from WhereField.vue - the user asked for a standalone
 * component, not a reuse/import of it, even though the Simple/Advanced
 * toggle concept below is the same pattern (see that file's own doc
 * comment) reimplemented from scratch for this value shape.
 *
 * Advanced reuses WidgetJsonEditor.vue as-is (Monaco + the
 * JSON.stringify/parse seam it already wraps) - no reason to
 * reimplement that half.
 *
 * Simple is offered only when the CURRENT value's shape is simple
 * enough to round-trip through a flat row editor without silently
 * dropping structure - same "too complex, don't touch it" discipline
 * WhereField applies to nested filter groups:
 *  - a plain object whose own values are all primitives (string/number/
 *    boolean/null, no nested object/array) -> a Property/Type/Value
 *    table.
 *  - an array whose own items are all primitives -> a single-column
 *    Type/Value list (no keys).
 *  - null/undefined (a brand new field with no value yet) -> treated
 *    as an empty object, so "+ Add property" has something to start
 *    from.
 *  - anything else (nested objects/arrays, a mixed array, a bare
 *    top-level string/number/boolean/null) -> Simple is disabled,
 *    forced to Advanced, same as WhereField's own canBuild/canUseSimple
 *    fallback.
 *
 * Every primitive's type is an explicit per-row choice (String/Number/
 * Boolean/Null), never guessed from the text typed - the user's own
 * call, so e.g. a value that happens to look like "true" or "123" is
 * never silently reinterpreted as the wrong JSON type.
 */
const modelValue = defineModel<unknown>()
const props = withDefaults(defineProps<{
  disabled?: boolean
  minHeight?: string
}>(), {
  disabled: false
})

type PrimType = 'string' | 'number' | 'boolean' | 'null'
type Primitive = string | number | boolean | null

function isPrimitive(value: unknown): value is Primitive {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}
function primTypeOf(value: Primitive): PrimType {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'string'
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

type Kind = 'object' | 'array' | null

/** null = too complex for Simple (nested, mixed, or a bare scalar root) - see the file's own doc comment above. */
function shapeOf(value: unknown): Kind {
  if (value === null || value === undefined) return 'object'
  if (Array.isArray(value)) return value.every(isPrimitive) ? 'array' : null
  if (isPlainObject(value)) return Object.values(value).every(isPrimitive) ? 'object' : null
  return null
}

interface Row {
  id: string
  key: string
  type: PrimType
  value: Primitive
}

function newRowId(): string {
  return Math.random().toString(36).slice(2)
}
function valueForRow(row: Row): Primitive {
  return row.type === 'null' ? null : row.value
}

const kind = ref<Kind>('object')
const rows = ref<Row[]>([])

const canUseSimple = computed(() => kind.value !== null)
const mode = ref<'simple' | 'advanced'>('advanced')
let userChangedMode = false
watch(canUseSimple, (ok) => {
  if (!ok) mode.value = 'advanced'
  else if (!userChangedMode) mode.value = 'simple'
})
function setMode(next: 'simple' | 'advanced') {
  userChangedMode = true
  mode.value = next
}

// Guards the rebuild-from-outside-value watch below against reacting to
// this component's own writes (syncFromRows -> modelValue.value = ...)
// - without it, every keystroke would rebuild `rows` from scratch with
// fresh ids, remounting each input and dropping focus/cursor position.
let lastEmittedJson: string | null = null

function toRows(value: unknown, forKind: Kind): Row[] {
  if (forKind === 'array') {
    return (value as unknown[] ?? []).map(v => ({ id: newRowId(), key: '', type: primTypeOf(v as Primitive), value: v as Primitive }))
  }
  if (forKind === 'object') {
    const obj = (value ?? {}) as Record<string, unknown>
    return Object.entries(obj).map(([k, v]) => ({ id: newRowId(), key: k, type: primTypeOf(v as Primitive), value: v as Primitive }))
  }
  return []
}

watch(() => modelValue.value, (value) => {
  const json = JSON.stringify(value ?? null)
  if (json === lastEmittedJson) return
  lastEmittedJson = json
  kind.value = shapeOf(value)
  rows.value = toRows(value, kind.value)
  if (!userChangedMode) mode.value = kind.value ? 'simple' : 'advanced'
}, { immediate: true })

function syncFromRows() {
  if (kind.value === null) return
  const built = kind.value === 'array'
    ? rows.value.map(valueForRow)
    : Object.fromEntries(rows.value.filter(r => r.key.trim() !== '').map(r => [r.key, valueForRow(r)]))
  lastEmittedJson = JSON.stringify(built)
  modelValue.value = built
}

function addRow() {
  rows.value.push({ id: newRowId(), key: '', type: 'string', value: '' })
  syncFromRows()
}
function removeRow(id: string) {
  rows.value = rows.value.filter(r => r.id !== id)
  syncFromRows()
}
function setRowKey(row: Row, key: string) {
  row.key = key
  syncFromRows()
}
function setRowType(row: Row, type: PrimType) {
  if (type === row.type) return
  switch (type) {
    case 'null':
      row.value = null
      break
    case 'boolean':
      row.value = row.value === true || row.value === 'true'
      break
    case 'number': {
      const n = Number(row.value)
      row.value = Number.isFinite(n) ? n : 0
      break
    }
    case 'string':
      row.value = row.value === null || row.value === undefined ? '' : String(row.value)
      break
  }
  row.type = type
  syncFromRows()
}
function setRowValue(row: Row, value: Primitive) {
  row.value = value
  syncFromRows()
}

const { t } = useI18n()
const TYPE_OPTIONS = computed<{ label: string, value: PrimType }[]>(() => [
  { label: t('dataviews.widgetJson.typeString'), value: 'string' },
  { label: t('dataviews.widgetJson.typeNumber'), value: 'number' },
  { label: t('dataviews.widgetJson.typeBoolean'), value: 'boolean' },
  { label: t('dataviews.widgetJson.typeNull'), value: 'null' }
])
</script>

<template>
  <div class="rounded-md border border-default p-[10px] flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <UFieldGroup>
        <UTooltip :text="canUseSimple ? '' : t('dataviews.widgetJson.tooComplex')">
          <UButton
            :label="t('dataviews.widgetJson.simple')"
            size="xs"
            :color="mode === 'simple' ? 'primary' : 'neutral'"
            :variant="mode === 'simple' ? 'solid' : 'outline'"
            :disabled="!canUseSimple || props.disabled"
            @click="setMode('simple')"
          />
        </UTooltip>
        <UButton
          :label="t('dataviews.widgetJson.advanced')"
          size="xs"
          :color="mode === 'advanced' ? 'primary' : 'neutral'"
          :variant="mode === 'advanced' ? 'solid' : 'outline'"
          @click="setMode('advanced')"
        />
      </UFieldGroup>
    </div>
    <USeparator />

    <template v-if="mode === 'simple'">
      <div class="flex flex-col gap-2">
        <div
          v-if="rows.length === 0"
          class="text-xs text-muted"
        >
          {{ kind === 'array' ? t('dataviews.widgetJson.noItems') : t('dataviews.widgetJson.noProperties') }}
        </div>
        <div
          v-else
          class="text-xs text-muted"
        >
          {{ kind === 'array' ? t('dataviews.widgetJson.eachItem') : t('dataviews.widgetJson.eachProperty') }}
        </div>

        <div
          v-for="row in rows"
          :key="row.id"
          class="flex items-center gap-1.5"
        >
          <UInput
            v-if="kind === 'object'"
            :model-value="row.key"
            :aria-label="t('dataviews.widgetJson.property')"
            size="sm"
            class="w-full"
            :disabled="props.disabled"
            @update:model-value="v => setRowKey(row, String(v))"
          />
          <USelect
            :aria-label="t('common.type')"
            :model-value="row.type"
            :items="TYPE_OPTIONS"
            size="sm"
            class="w-32 shrink-0"
            :disabled="props.disabled"
            @update:model-value="v => setRowType(row, v as PrimType)"
          />
          <UInputNumber
            v-if="row.type === 'number'"
            :aria-label="t('common.value')"
            :model-value="row.value as number"
            size="sm"
            class="w-full"
            :disabled="props.disabled"
            @update:model-value="v => setRowValue(row, (v ?? 0) as number)"
          />
          <USwitch
            v-else-if="row.type === 'boolean'"
            :model-value="row.value as boolean"
            :disabled="props.disabled"
            @update:model-value="v => setRowValue(row, !!v)"
          />
          <UInput
            v-else-if="row.type === 'string'"
            :model-value="row.value as string"
            :aria-label="t('common.value')"
            size="sm"
            class="w-full"
            :disabled="props.disabled"
            @update:model-value="v => setRowValue(row, String(v))"
          />
          <span
            v-else
            class="w-full text-sm text-muted italic px-2"
          >null</span>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="props.disabled"
            :aria-label="kind === 'array' ? t('dataviews.widgetJson.removeItem') : t('dataviews.widgetJson.removeProperty')"
            @click="removeRow(row.id)"
          />
        </div>

        <UButton
          icon="i-lucide-plus"
          :label="kind === 'array' ? t('dataviews.widgetJson.addItem') : t('dataviews.widgetJson.addProperty')"
          size="sm"
          color="neutral"
          variant="outline"
          class="self-start"
          :disabled="props.disabled"
          @click="addRow"
        />
      </div>
    </template>

    <WidgetJsonEditor
      v-show="mode === 'advanced'"
      v-model="modelValue"
      :min-height="props.minHeight"
      :disabled="props.disabled"
    />
  </div>
</template>
