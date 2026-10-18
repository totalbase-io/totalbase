<script setup lang="ts">
/**
 * One table column's settings (`TableColumnSettings`, @totalbase/tb-catalog -
 * Specification_DataViews.md §15): its title, what it
 * shows of the value (format, empty text, true/false labels, link) and how
 * its cells look (TableCellStyleFields.vue). Only what its type takes. An
 * unset key is dropped from the model, never stored empty; with
 * `inherited`, what it falls back to is named under each field.
 */
import { columnPresentationOptions, type TableColumnSettings, type ValueKind } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'

const props = defineProps<{
  columnName: string
  /** The title it shows when none is set - its name, or a page Table's humanized name. */
  defaultTitle?: string
  kind: ValueKind
  /** What the column falls back to when a key is unset here - a resource column's presentation. */
  inherited?: TableColumnSettings
  /** A page Table's: the fields its Color per row formula reads - none, no such formula (a Dashboard's colors come from its SQL). */
  formulaColumns?: CatalogColumn[]
}>()
const model = defineModel<TableColumnSettings>({ required: true })
const { t } = useI18n()

const options = computed(() => columnPresentationOptions(props.kind))

function set(key: keyof TableColumnSettings, value: unknown) {
  const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    || (typeof value === 'object' && Object.values(value as object).every(v => v === undefined || v === ''))
  model.value = Object.fromEntries(Object.entries({ ...model.value, [key]: value }).filter(([k]) => k !== key || !empty)) as TableColumnSettings
}

/** "Inherited: ..." under a field, when there is something to inherit. */
function inheritedHelp(value: string | undefined, fallback: string): string {
  return value ? t('database.tableColumnFields.inherited', { value }) : fallback
}

const LINK_ITEMS = computed(() => [
  { label: t('common.none'), value: 'none' },
  { label: t('database.tableColumnFields.linkUrl'), value: 'url' },
  { label: t('database.tableColumnFields.linkEmail'), value: 'email' },
  { label: t('database.tableColumnFields.linkPhone'), value: 'tel' }
])
</script>

<template>
  <div class="flex flex-col gap-3">
    <UFormField
      :label="t('database.tableColumnFields.title')"
      :description="inheritedHelp(inherited?.label, t('database.tableColumnFields.emptyAs', { value: defaultTitle ?? columnName }))"
    >
      <UInput
        :model-value="model.label ?? ''"
        size="sm"
        class="w-full"
        @update:model-value="(v: string) => set('label', v)"
      />
    </UFormField>
    <DisplayFormatField
      v-if="options.displayFormat"
      :model-value="model.displayFormat"
      :kind="kind"
      size="sm"
      :description="inherited?.displayFormat ? t('database.tableColumnFields.inherited', { value: inherited.displayFormat }) : undefined"
      @update:model-value="(v?: string) => set('displayFormat', v)"
    />
    <div
      v-if="options.booleanLabels"
      class="flex gap-2"
    >
      <UFormField
        :label="t('database.tableColumnFields.trueAs')"
        :description="inheritedHelp(inherited?.booleanLabels?.true, t('database.tableColumnFields.emptyAs', { value: t('common.yes') }))"
        class="flex-1"
      >
        <UInput
          :model-value="model.booleanLabels?.true ?? ''"
          size="sm"
          class="w-full"
          @update:model-value="(v: string) => set('booleanLabels', { ...model.booleanLabels, true: v || undefined })"
        />
      </UFormField>
      <UFormField
        :label="t('database.tableColumnFields.falseAs')"
        :description="inheritedHelp(inherited?.booleanLabels?.false, t('database.tableColumnFields.emptyAs', { value: t('common.no') }))"
        class="flex-1"
      >
        <UInput
          :model-value="model.booleanLabels?.false ?? ''"
          size="sm"
          class="w-full"
          @update:model-value="(v: string) => set('booleanLabels', { ...model.booleanLabels, false: v || undefined })"
        />
      </UFormField>
    </div>
    <UFormField
      v-if="options.linkType"
      :label="t('database.tableColumnFields.link')"
      :description="inheritedHelp(inherited?.linkType, t('database.tableColumnFields.linkHelp'))"
    >
      <USelect
        :model-value="model.linkType ?? 'none'"
        :items="LINK_ITEMS"
        size="sm"
        class="w-full"
        @update:model-value="(v: string) => set('linkType', v === 'url' || v === 'email' || v === 'tel' ? v : undefined)"
      />
    </UFormField>
    <UFormField
      :label="t('database.tableColumnFields.emptyText')"
      :description="inheritedHelp(inherited?.emptyText, t('database.tableColumnFields.emptyTextHelp'))"
    >
      <UInput
        :model-value="model.emptyText ?? ''"
        size="sm"
        class="w-full"
        @update:model-value="(v: string) => set('emptyText', v)"
      />
    </UFormField>
    <TableCellStyleFields
      :model-value="model"
      size="sm"
      @update:model-value="(style) => model = style as TableColumnSettings"
    />
    <UFormField
      v-if="formulaColumns"
      :label="t('database.tableColumnFields.colorPerRow')"
      :description="t('database.tableColumnFields.colorPerRowHelp', { example: '{{saldo}} < 0 ? &quot;red&quot; : &quot;&quot;' })"
    >
      <div class="flex items-center gap-1">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{{ model.colorFormula || t('common.none') }}</span>
        <BindingButton
          :model-value="model.colorFormula ?? ''"
          kind="value"
          :label="t('database.tableColumnFields.colorPerRowBinding', { column: columnName })"
          :columns="formulaColumns"
          @update:model-value="(v: string) => set('colorFormula', v)"
        />
      </div>
    </UFormField>
  </div>
</template>
