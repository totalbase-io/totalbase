<script setup lang="ts">
/**
 * A page Table's computed columns (`TableComputedColumn`,
 * Specification_DataViews.md §15): one card each - its
 * title, what its formula gives (how its cells format) and its formula per
 * row, over its Rows' fields and the computed columns before it. Its name
 * is set once, when it's added, and shown: Columns sets its look under it,
 * and a later formula reads it as `{{name}}`.
 */
import { COMPUTED_COLUMN_TYPES, type TableComputedColumn } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import { COMPUTED_DATA_TYPES } from '~/utils/widget-table'

const props = defineProps<{
  label: string
  description?: string
  /** Its Rows' fields - what a formula reads as {{campo}}. */
  columns: CatalogColumn[]
}>()
const model = defineModel<TableComputedColumn[] | undefined>({ required: true })
const { t } = useI18n()

const list = computed(() => model.value ?? [])

/** The fields a column's formula reads: its Rows', then the computed columns before it. */
function formulaColumns(index: number): CatalogColumn[] {
  return [
    ...props.columns,
    ...list.value.slice(0, index).map((c, i) => ({
      attnum: props.columns.length + i + 1, name: c.key, dataType: COMPUTED_DATA_TYPES[c.type], nullable: true, isIdentity: false, isGenerated: false, defaultExpression: null
    }))
  ]
}

function update(index: number, patch: Partial<TableComputedColumn>) {
  model.value = list.value.map((column, i) => {
    if (i !== index) return column
    const next = { ...column, ...patch }
    if (!next.label?.trim()) delete next.label
    return next
  })
}
function add() {
  const taken = new Set([...list.value.map(c => c.key), ...props.columns.map(c => c.name)])
  let n = list.value.length + 1
  while (taken.has(`computed_${n}`)) n++
  model.value = [...list.value, { key: `computed_${n}`, label: t('database.tableComputedColumnsEditor.defaultLabel', { n }), type: 'number', formula: '' }]
}
function remove(index: number) {
  const next = list.value.filter((_, i) => i !== index)
  model.value = next.length ? next : undefined
}

const TYPE_ITEMS = COMPUTED_COLUMN_TYPES.map(type => ({ label: type, value: type }))
</script>

<template>
  <UFormField
    :label="props.label"
    :description="props.description"
  >
    <div class="flex flex-col gap-2">
      <div
        v-for="(column, index) in list"
        :key="column.key"
        class="flex flex-col gap-2 rounded-md border border-default p-2"
      >
        <div class="flex items-center gap-1.5">
          <UInput
            :model-value="column.label ?? ''"
            :aria-label="t('database.tableComputedColumnsEditor.titleAria', { n: index + 1 })"
            size="sm"
            class="min-w-0 flex-1"
            @update:model-value="update(index, { label: String($event ?? '') })"
          />
          <USelect
            :model-value="column.type"
            :items="TYPE_ITEMS"
            size="sm"
            class="w-28"
            :aria-label="t('common.type')"
            @update:model-value="update(index, { type: $event as TableComputedColumn['type'] })"
          />
          <BindingButton
            :model-value="column.formula"
            kind="value"
            :label="t('database.tableComputedColumnsEditor.perRow', { name: column.label || column.key })"
            :columns="formulaColumns(index)"
            @update:model-value="update(index, { formula: $event })"
          />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('database.tableComputedColumnsEditor.remove')"
            @click="remove(index)"
          />
        </div>
        <p class="truncate font-mono text-xs text-muted">
          {{ column.key }} = {{ column.formula || t('database.tableComputedColumnsEditor.formulaHint') }}
        </p>
      </div>
      <UButton
        icon="i-lucide-plus"
        :label="t('database.tableComputedColumnsEditor.add')"
        size="sm"
        color="neutral"
        variant="outline"
        class="self-start"
        :disabled="columns.length === 0"
        @click="add"
      />
    </div>
  </UFormField>
</template>
