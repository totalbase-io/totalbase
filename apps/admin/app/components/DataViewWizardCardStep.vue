<script setup lang="ts">
// DataView wizard, CARDS layout step: which visible column feeds each
// card's image, title and description (`card_layout`).
import type { CardLayoutConfig } from '~/types/dataview'
import type { WizardColumn } from '~/utils/dataview-wizard-layouts'

const layout = defineModel<CardLayoutConfig>({ required: true })
defineProps<{ columns: WizardColumn[] }>()
const { t } = useI18n()

const field = useModelField(layout)
const image = useFormulaColumn(field('imageFormula'))
const title = useFormulaColumn(field('titleFormula'))
const description = useFormulaColumn(field('descriptionFormula'))
</script>

<template>
  <div class="flex flex-col gap-4">
    <DataViewColumnSelect
      v-model="image"
      :label="t('designer.dataViewWizardCardStep.image')"
      :description="t('designer.dataViewWizardCardStep.imageHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="title"
      :label="t('designer.dataViewWizardCardStep.title')"
      :description="t('designer.dataViewWizardCardStep.titleHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="description"
      :label="t('common.description')"
      :description="t('designer.dataViewWizardCardStep.descriptionHelp')"
      :options="columns"
    />
  </div>
</template>
