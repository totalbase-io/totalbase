<script setup lang="ts">
/**
 * A column's Conditions (Specification_DataViews.md §15.7): how it looks when something holds - an ordered list of
 * named cards, the first that holds winning (per cell and per row; a cell's over a row's), added on top of its base
 * style. Each: a filter in the `where` grammar (WhereField - $ROW, $USER, $CURRENT_DATE, $PERIOD, paths by FK), where
 * it applies (the cell or the whole row) and its look (TableCellStyleFields, plus an icon, a badge or dimmed). Cards
 * move by their grip or their "⋮", turn off without being deleted, duplicate. PostgreSQL evaluates them.
 */
import type { ColumnCondition, ConditionStyle } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'

const conditions = defineModel<ColumnCondition[]>({ required: true })
defineProps<{
  /** The table's columns - the filter builder's fields. */
  columns?: CatalogColumn[]
  /** The column it's for - a new condition's starting filter. */
  columnName: string
}>()

const { t } = useI18n()
/** Each card's filter as text while it's edited - kept apart so a half-typed one isn't lost. */
const whereTexts = ref<string[]>([])
/** What's wrong with a card's filter: not JSON, or nothing in it yet (a new condition, or its last one removed) - the server wants a filter. */
const whereErrors = ref<('invalid' | 'empty' | null)[]>([])
/** The texts again from the conditions - on load and after a card is added, moved, duplicated or removed. */
function syncTexts() {
  whereTexts.value = conditions.value.map(c => (Object.keys(c.where).length === 0 ? '' : JSON.stringify(c.where, null, 2)))
  whereErrors.value = conditions.value.map(c => (Object.keys(c.where).length === 0 ? 'empty' : null))
}
syncTexts()

function update(index: number, patch: Partial<ColumnCondition>) {
  conditions.value = conditions.value.map((c, i) => (i === index ? { ...c, ...patch } : c))
}
function setWhere(index: number, text: string) {
  whereTexts.value[index] = text
  // Simple mode's last condition removed, or a cleared editor: kept as a card with no filter, flagged until it has one.
  if (!text.trim()) {
    whereErrors.value[index] = 'empty'
    update(index, { where: {} })
    return
  }
  try {
    const parsed = JSON.parse(text) as unknown
    const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    whereErrors.value[index] = valid ? (Object.keys(parsed as object).length === 0 ? 'empty' : null) : 'invalid'
    if (valid) update(index, { where: parsed as Record<string, unknown> })
  } catch {
    whereErrors.value[index] = 'invalid'
  }
}
function setStyle(index: number, style: ConditionStyle) {
  update(index, { style })
}
function toggleStyle(index: number, key: 'badge' | 'dim') {
  const { [key]: on, ...rest } = conditions.value[index]!.style
  setStyle(index, on ? rest : { ...rest, [key]: true })
}
function uniqueName(base: string): string {
  const taken = new Set(conditions.value.map(c => c.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}
function add() {
  // No filter yet: the builder opens on this column, the viewer picks the operator and the value and adds it - a seeded `id = ''` was a real (and wrong) condition.
  conditions.value = [...conditions.value, { name: uniqueName(t('database.columnConditions.newName')), where: {}, style: { color: 'red' } }]
  syncTexts()
}
function duplicate(index: number) {
  const copy = structuredClone(toRaw(conditions.value[index]!))
  copy.name = uniqueName(copy.name)
  conditions.value = [...conditions.value.slice(0, index + 1), copy, ...conditions.value.slice(index + 1)]
  syncTexts()
}
function remove(index: number) {
  conditions.value = conditions.value.filter((_, i) => i !== index)
  syncTexts()
}
function move(from: number, to: number) {
  if (to < 0 || to >= conditions.value.length || from === to) return
  const next = [...conditions.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  conditions.value = next
  syncTexts()
}
function menu(index: number) {
  return [[
    { label: t('database.columnConditions.duplicate'), icon: 'i-lucide-copy', onSelect: () => duplicate(index) },
    { label: t('database.columnConditions.moveUp'), icon: 'i-lucide-arrow-up', disabled: index === 0, onSelect: () => move(index, index - 1) },
    { label: t('database.columnConditions.moveDown'), icon: 'i-lucide-arrow-down', disabled: index === conditions.value.length - 1, onSelect: () => move(index, index + 1) }
  ], [
    { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => remove(index) }
  ]]
}

// Dragging a card by its grip.
const dragging = ref<number | null>(null)
const over = ref<number | null>(null)
function onDrop(index: number) {
  if (dragging.value !== null) move(dragging.value, index)
  dragging.value = null
  over.value = null
}
const APPLY_ITEMS = computed(() => [
  { label: t('database.columnConditions.applyCell'), value: 'cell' },
  { label: t('database.columnConditions.applyRow'), value: 'row' }
])
</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="text-sm text-muted">
      {{ t('database.columnConditions.intro') }}
    </p>
    <div
      v-for="(condition, index) in conditions"
      :key="index"
      class="flex flex-col gap-3 rounded-md border p-3"
      :class="[over === index ? 'border-primary' : 'border-default', condition.enabled === false ? 'opacity-60' : undefined, dragging === index ? 'opacity-40' : undefined]"
      @dragover.prevent="dragging !== null && (over = index)"
      @dragleave="over === index && (over = null)"
      @drop.prevent="onDrop(index)"
    >
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-grip-vertical"
          class="size-4 shrink-0 cursor-grab text-dimmed"
          draggable="true"
          @dragstart="dragging = index"
          @dragend="dragging = null; over = null"
        />
        <UInput
          :model-value="condition.name"
          :aria-label="t('database.columnConditions.name')"
          class="min-w-0 flex-1"
          @update:model-value="(v: string) => update(index, { name: v })"
        />
        <USwitch
          :model-value="condition.enabled !== false"
          :aria-label="t('database.columnConditions.enabled', { name: condition.name })"
          @update:model-value="(on: boolean) => update(index, { enabled: on ? undefined : false })"
        />
        <UDropdownMenu :items="menu(index)">
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('database.columnConditions.actions', { name: condition.name })"
          />
        </UDropdownMenu>
      </div>
      <WhereField
        :model-value="whereTexts[index] ?? ''"
        :label="t('database.columnConditions.when')"
        :description="t('database.columnConditions.whenHelp')"
        :error="whereErrors[index] === 'invalid' ? t('database.columnConditions.invalidJson') : whereErrors[index] === 'empty' ? t('database.columnConditions.needsFilter') : null"
        :columns="columns"
        :default-field="columnName"
        default-mode="simple"
        min-height="6rem"
        @update:model-value="(v: string) => setWhere(index, v)"
      />
      <UFormField :label="t('database.columnConditions.applyTo')">
        <URadioGroup
          :model-value="condition.applyTo ?? 'cell'"
          :items="APPLY_ITEMS"
          orientation="horizontal"
          @update:model-value="(v: string) => update(index, { applyTo: v === 'row' ? 'row' : undefined })"
        />
      </UFormField>
      <TableCellStyleFields
        :model-value="condition.style"
        size="sm"
        @update:model-value="(style) => setStyle(index, style as ConditionStyle)"
      />
      <div class="flex flex-wrap items-end gap-3">
        <IconPickerField
          :model-value="condition.style.icon"
          :label="t('common.icon')"
          options="lucide"
          clearable
          @update:model-value="(v: string | undefined) => setStyle(index, { ...condition.style, icon: v })"
        />
        <UCheckbox
          :model-value="condition.style.badge === true"
          :label="t('database.columnConditions.badge')"
          @update:model-value="toggleStyle(index, 'badge')"
        />
        <UCheckbox
          :model-value="condition.style.dim === true"
          :label="t('database.columnConditions.dim')"
          @update:model-value="toggleStyle(index, 'dim')"
        />
      </div>
    </div>
    <div>
      <UButton
        icon="i-lucide-plus"
        :label="t('database.columnConditions.add')"
        color="neutral"
        variant="outline"
        @click="add"
      />
    </div>
  </div>
</template>
