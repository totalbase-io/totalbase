<script setup lang="ts">
// DataView wizard, TREE layout step (Specification_DataViews.md §5.14): the parent - a foreign key of the table to
// itself -, an optional order column, each node's content, how it opens, and the cycle guard.
import { isNumericDataType } from '@totalbase/tb-catalog'
import type { TreeDisplay, TreeLayoutConfig } from '~/types/dataview'
import type { WizardColumn } from '~/utils/dataview-wizard-layouts'

const layout = defineModel<TreeLayoutConfig>({ required: true })
const cycleGuard = defineModel<boolean>('cycleGuard', { required: true })
const props = defineProps<{
  /** The visible columns - a node's content. */
  columns: WizardColumn[]
  /** Every column - the parent and the order may be hidden ones. */
  allColumns: WizardColumn[]
  /** The source is a table the configured role may alter. */
  canGuard: boolean
}>()
const { t } = useI18n()
const T = 'designer.dataViewWizardTreeStep'

const field = useModelField(layout)
const parentColumn = field('parentColumn')
const orderColumn = field('orderColumn')
const title = useFormulaColumn(field('titleFormula'))
const description = useFormulaColumn(field('descriptionFormula'))
const image = useFormulaColumn(field('imageFormula'))
const colorColumn = useFormulaColumn(field('colorFormula'))
const defaultDisplay = field('defaultDisplay')
const expandLevel = field('expandLevel')

const parentColumns = computed(() => props.allColumns.filter(c => c.isSelfReference))
const numberColumns = computed(() => props.allColumns.filter(c => isNumericDataType(c.dataType) && !c.isForeignKey))
const DISPLAYS: TreeDisplay[] = ['tree', 'org']
</script>

<template>
  <div class="flex flex-col gap-4">
    <UAlert
      v-if="parentColumns.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t(`${T}.noParent`)"
      :description="t(`${T}.noParentHelp`)"
    />
    <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <DataViewColumnSelect
        v-model="parentColumn"
        :label="t(`${T}.parent`)"
        :description="t(`${T}.parentHelp`)"
        :options="parentColumns"
      />
      <DataViewColumnSelect
        v-model="orderColumn"
        :label="t(`${T}.order`)"
        :description="t(`${T}.orderHelp`)"
        :options="numberColumns"
      />
    </div>
    <UCheckbox
      v-if="canGuard && parentColumn"
      v-model="cycleGuard"
      :label="t(`${T}.cycleGuard`)"
      :description="t(`${T}.cycleGuardHelp`)"
    />

    <DataViewColumnSelect
      v-model="title"
      :label="t(`${T}.title`)"
      :description="t(`${T}.titleHelp`)"
      :options="columns"
    />
    <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <DataViewColumnSelect
        v-model="description"
        :label="t(`${T}.description`)"
        :description="t(`${T}.descriptionHelp`)"
        :options="columns"
      />
      <DataViewColumnSelect
        v-model="image"
        :label="t(`${T}.image`)"
        :description="t(`${T}.imageHelp`)"
        :options="columns"
      />
    </div>
    <DataViewColumnSelect
      v-model="colorColumn"
      :label="t(`${T}.color`)"
      :description="t(`${T}.colorHelp`)"
      :options="columns"
    />

    <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <UFormField
        :label="t(`${T}.display`)"
        :description="t(`${T}.displayHelp`)"
      >
        <USelect
          v-model="defaultDisplay"
          :items="DISPLAYS.map(value => ({ value, label: t(`dataviews.treeView.displays.${value}`) }))"
          class="w-full"
        />
      </UFormField>
      <UFormField
        :label="t(`${T}.expandLevel`)"
        :description="t(`${T}.expandLevelHelp`)"
      >
        <UInputNumber
          v-model="expandLevel"
          :min="0"
          :max="20"
          class="w-full"
        />
      </UFormField>
    </div>
  </div>
</template>
