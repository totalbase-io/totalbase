<script setup lang="ts">
// DataView wizard, KANBAN layout step: the column whose values become the lanes - a
// foreign key (a lane per related row) or a CHECK list (a lane per value), never
// free-text values (Specification_DataViews.md §5.5) - plus each card's content.
import type { KanbanLayoutConfig } from '~/types/dataview'
import type { WizardColumn } from '~/utils/dataview-wizard-layouts'

const layout = defineModel<KanbanLayoutConfig>({ required: true })
const props = defineProps<{ columns: WizardColumn[] }>()
const { t } = useI18n()

const field = useModelField(layout)
const groupColumn = field('groupColumn')
const image = useFormulaColumn(field('imageFormula'))
const title = useFormulaColumn(field('titleFormula'))
const description = useFormulaColumn(field('descriptionFormula'))

/** The same candidates pickKanbanLayout proposes from (utils/dataview-wizard-layouts.ts). */
const groupColumns = computed(() => props.columns.filter(c => c.isForeignKey || c.isCheckList))
</script>

<template>
  <div class="flex flex-col gap-4">
    <DataViewColumnSelect
      v-model="groupColumn"
      :label="t('designer.dataViewWizardKanbanStep.groupBy')"
      :description="t('designer.dataViewWizardKanbanStep.groupByHelp')"
      :options="groupColumns"
    />

    <UAlert
      v-if="groupColumns.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewWizardKanbanStep.noForeignKeys')"
    />

    <DataViewColumnSelect
      v-model="image"
      :label="t('designer.dataViewWizardKanbanStep.cardImage')"
      :description="t('designer.dataViewWizardKanbanStep.cardImageHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="title"
      :label="t('designer.dataViewWizardKanbanStep.cardTitle')"
      :description="t('designer.dataViewWizardKanbanStep.cardTitleHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="description"
      :label="t('designer.dataViewWizardKanbanStep.cardDescription')"
      :description="t('designer.dataViewWizardKanbanStep.cardDescriptionHelp')"
      :options="columns"
    />
  </div>
</template>
