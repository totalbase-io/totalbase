<script setup lang="ts">
// DataView settings, TREE layout (`view_config.tree_layout`, DataViews.md §5.14): the parent - a
// foreign key of the table to itself -, the order column, each node's formulas, how it opens.
import { isNumericDataType } from '@totalbase/tb-catalog'
import type { TreeDisplay, TreeLayoutConfig } from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'
import { columnOptions, columnFieldsOfType, type DataViewColumnField } from '~/utils/dataview-columns'

const layout = defineModel<TreeLayoutConfig>({ required: true })
const props = defineProps<{
  columnFields: DataViewColumnField[]
  bindingColumns: CatalogColumn[]
  relations?: RelationDefinition[]
  /** The source's foreign keys to itself, by column. */
  selfReferences: string[]
}>()
const { t } = useI18n()
const T = 'designer.dataViewTreeSettings'

const field = useModelField(layout)
const parentColumn = field('parentColumn')
const orderColumn = field('orderColumn')
const titleFormula = field('titleFormula')
const descriptionFormula = field('descriptionFormula')
const iconFormula = field('iconFormula')
const colorFormula = field('colorFormula')
const imageFormula = field('imageFormula')
const defaultDisplay = field('defaultDisplay')
const expandLevel = field('expandLevel')

const parentOptions = computed(() => columnOptions(props.columnFields.filter(f => f.columnName && props.selfReferences.includes(f.columnName))))
const numericOptions = computed(() => columnOptions(columnFieldsOfType(props.columnFields, props.bindingColumns, isNumericDataType)))
const DISPLAYS: TreeDisplay[] = ['tree', 'org']
</script>

<template>
  <SettingsSection :title="t(`${T}.heading`)">
    <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <DataViewColumnSelect
        v-model="parentColumn"
        :label="t('designer.dataViewWizardTreeStep.parent')"
        :description="t('designer.dataViewWizardTreeStep.parentHelp')"
        :options="parentOptions"
        :validate="bindingColumns.length > 0"
      />
      <DataViewColumnSelect
        v-model="orderColumn"
        :label="t('designer.dataViewWizardTreeStep.order')"
        :description="t('designer.dataViewWizardTreeStep.orderHelp')"
        :options="numericOptions"
        :validate="bindingColumns.length > 0"
      />
    </div>
    <UAlert
      v-if="selfReferences.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewWizardTreeStep.noParent')"
      :description="t('designer.dataViewWizardTreeStep.noParentHelp')"
    />

    <DataViewFormulaField
      v-model="titleFormula"
      :label="t('designer.dataViewWizardTreeStep.title')"
      :description="t('designer.dataViewWizardTreeStep.titleHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />
    <DataViewFormulaField
      v-model="descriptionFormula"
      :label="t('designer.dataViewWizardTreeStep.description')"
      :description="t('designer.dataViewWizardTreeStep.descriptionHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />
    <DataViewFormulaField
      v-model="imageFormula"
      :label="t('designer.dataViewWizardTreeStep.image')"
      :description="t('designer.dataViewWizardTreeStep.imageHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />
    <DataViewFormulaField
      v-model="iconFormula"
      :label="t(`${T}.icon`)"
      :description="t(`${T}.iconHelp`)"
      :columns="bindingColumns"
      :relations="relations"
    />
    <DataViewFormulaField
      v-model="colorFormula"
      :label="t('common.color')"
      :description="t('designer.dataViewWizardTreeStep.colorHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <UFormField
        :label="t('designer.dataViewWizardTreeStep.display')"
        :description="t('designer.dataViewWizardTreeStep.displayHelp')"
      >
        <USelect
          v-model="defaultDisplay"
          :items="DISPLAYS.map(value => ({ value, label: t(`dataviews.treeView.displays.${value}`) }))"
          class="w-full"
        />
      </UFormField>
      <UFormField
        :label="t('designer.dataViewWizardTreeStep.expandLevel')"
        :description="t('designer.dataViewWizardTreeStep.expandLevelHelp')"
      >
        <UInputNumber
          v-model="expandLevel"
          :min="0"
          :max="20"
          class="w-full"
        />
      </UFormField>
    </div>
  </SettingsSection>
</template>
