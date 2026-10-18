<script setup lang="ts">
/**
 * A Table's Row actions, one per row: its icon, its Name - what Action
 * clicked receives as `event.action` - and its tooltip. Like Custom
 * attributes, a row being typed stays until removed; one without a name
 * isn't saved, nor a repeated name. Each may be off or hidden on a row by
 * a formula over that row's fields (`columns`) and the page.
 */
import type { TableAction } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'

const props = defineProps<{
  label: string
  description?: string
  /** Its Rows' fields - what a Disabled or Visible formula reads as {{campo}}. */
  columns?: CatalogColumn[]
}>()
const model = defineModel<TableAction[] | undefined>({ required: true })
const { t } = useI18n()

interface Row { icon?: string, name: string, label: string, formulas?: TableAction['formulas'] }
const rows = ref<Row[]>([])
function saved(list: readonly Row[]): TableAction[] {
  const seen = new Set<string>()
  return list.flatMap((row) => {
    const name = row.name.trim()
    if (!name || seen.has(name)) return []
    seen.add(name)
    const formulas = Object.fromEntries(Object.entries(row.formulas ?? {}).filter(([, f]) => f?.trim()))
    return [{ name, ...(row.icon ? { icon: row.icon } : {}), ...(row.label.trim() ? { label: row.label.trim() } : {}), ...(Object.keys(formulas).length ? { formulas } : {}) }]
  })
}
/** Compared by content, never as JSON text: the stored actions come back with their keys in jsonb's order. */
function same(a: readonly TableAction[] | undefined, b: readonly TableAction[] | undefined): boolean {
  const key = (list: readonly TableAction[] | undefined) => (list ?? []).map(x => [x.name, x.icon ?? '', x.label ?? '', x.formulas?.disabled ?? '', x.formulas?.visible ?? ''].join('\u0000')).join('\u0001')
  return key(a) === key(b)
}
// Seeded from the stored actions - not while typing, which would drop a row without a name yet.
watch(model, (value) => {
  if (!same(value, saved(rows.value))) rows.value = (value ?? []).map(a => ({ icon: a.icon, name: a.name, label: a.label ?? '', formulas: a.formulas }))
}, { immediate: true })
watch(rows, (list) => {
  const next = saved(list)
  if (!same(next, model.value)) model.value = next.length ? next : undefined
}, { deep: true })
</script>

<template>
  <UFormField
    :label="props.label"
    :description="props.description"
  >
    <div class="flex flex-col gap-2">
      <div
        v-if="rows.length > 0"
        class="grid grid-cols-[2rem_1fr_1fr_2rem] gap-1.5 text-xs text-muted"
      >
        <span>{{ t('common.icon') }}</span>
        <span>{{ t('common.name') }}</span>
        <span>{{ t('database.tableActionsEditor.tooltip') }}</span>
      </div>
      <template
        v-for="(row, index) in rows"
        :key="index"
      >
        <div class="grid grid-cols-[2rem_1fr_1fr_2rem] items-center gap-1.5">
          <IconPickerField
            v-model="row.icon"
            label=""
            options="lucide"
            clearable
          />
          <UInput
            v-model="row.name"
            :aria-label="t('database.tableActionsEditor.nameAria', { n: index + 1 })"
            size="sm"
            class="w-full font-mono"
          />
          <UInput
            v-model="row.label"
            :aria-label="t('database.tableActionsEditor.tooltipAria', { n: index + 1 })"
            size="sm"
            class="w-full"
          />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            :aria-label="t('database.tableActionsEditor.remove')"
            @click="rows.splice(index, 1)"
          />
        </div>
        <!-- Per row: off, or not there - a formula over its fields and the page. -->
        <div
          v-if="columns"
          class="-mt-1 flex items-center gap-3 pl-9 text-xs text-muted"
        >
          <span class="flex items-center gap-0.5">
            {{ t('database.tableActionsEditor.disabled') }}
            <BindingButton
              :model-value="row.formulas?.disabled ?? ''"
              kind="boolean"
              :label="t('database.tableActionsEditor.disabledPerRow', { name: row.name || t('database.tableActionsEditor.action') })"
              :columns="columns"
              @update:model-value="row.formulas = { ...row.formulas, disabled: $event }"
            />
          </span>
          <span class="flex items-center gap-0.5">
            {{ t('database.tableActionsEditor.visible') }}
            <BindingButton
              :model-value="row.formulas?.visible ?? ''"
              kind="boolean"
              :label="t('database.tableActionsEditor.visiblePerRow', { name: row.name || t('database.tableActionsEditor.action') })"
              :columns="columns"
              @update:model-value="row.formulas = { ...row.formulas, visible: $event }"
            />
          </span>
        </div>
      </template>
      <UButton
        icon="i-lucide-plus"
        :label="t('database.tableActionsEditor.add')"
        size="sm"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="rows.push({ name: '', label: '' })"
      />
    </div>
  </UFormField>
</template>
