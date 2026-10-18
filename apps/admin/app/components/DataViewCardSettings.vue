<script setup lang="ts">
// DataView settings, CARDS layout (`view_config.card_layout`).
import { CARD_IMAGE_ASPECTS, type CardLayoutConfig } from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'

const layout = defineModel<CardLayoutConfig>({ required: true })
defineProps<{
  bindingColumns: CatalogColumn[]
  relations?: RelationDefinition[]
}>()
const { t } = useI18n()

const field = useModelField(layout)
const imageFormula = field('imageFormula')
const titleFormula = field('titleFormula')
const descriptionFormula = field('descriptionFormula')
const imageAspect = field('imageAspect')
const imageFit = field('imageFit')
const imagePosition = field('imagePosition')

// Unset is "Default" - a 16:9 band covered from its center, as cards always were.
const DEFAULT = '__default'
const aspectItems = computed(() => [
  { value: DEFAULT, label: t('designer.dataViewCardSettings.default') },
  ...CARD_IMAGE_ASPECTS.map(value => ({ value, label: value === 'original' ? t('designer.dataViewCardSettings.original') : value }))
])
const fitItems = computed(() => [
  { value: 'cover', label: t('designer.dataViewCardSettings.cover') },
  { value: 'contain', label: t('designer.dataViewCardSettings.contain') }
])
const positionItems = computed(() => [
  { value: 'center', label: t('designer.dataViewCardSettings.center') },
  { value: 'top', label: t('designer.dataViewCardSettings.top') }
])
</script>

<template>
  <SettingsSection :title="t('designer.dataViewCardSettings.heading')">
    <DataViewFormulaField
      v-model="imageFormula"
      :label="t('designer.dataViewCardSettings.cardImage')"
      :description="t('designer.dataViewCardSettings.cardImageHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <!-- One per line, as every other setting here: side by side, descriptions of different lengths left the selects uneven. -->
    <template v-if="imageFormula">
      <UFormField
        :label="t('designer.dataViewCardSettings.imageAspect')"
        :description="t('designer.dataViewCardSettings.imageAspectHelp')"
      >
        <USelect
          :model-value="imageAspect ?? DEFAULT"
          :items="aspectItems"
          class="w-full"
          @update:model-value="(v: string) => imageAspect = v === DEFAULT ? null : v as CardLayoutConfig['imageAspect']"
        />
      </UFormField>
      <UFormField
        :label="t('designer.dataViewCardSettings.imageFit')"
        :description="t('designer.dataViewCardSettings.imageFitHelp')"
      >
        <USelect
          :model-value="imageFit ?? 'cover'"
          :items="fitItems"
          :disabled="imageAspect === 'original'"
          class="w-full"
          @update:model-value="(v: string) => imageFit = v === 'cover' ? null : 'contain'"
        />
      </UFormField>
      <UFormField
        :label="t('designer.dataViewCardSettings.imagePosition')"
        :description="t('designer.dataViewCardSettings.imagePositionHelp')"
      >
        <USelect
          :model-value="imagePosition ?? 'center'"
          :items="positionItems"
          :disabled="imageAspect === 'original'"
          class="w-full"
          @update:model-value="(v: string) => imagePosition = v === 'center' ? null : 'top'"
        />
      </UFormField>
    </template>

    <DataViewFormulaField
      v-model="titleFormula"
      :label="t('designer.dataViewCardSettings.cardTitle')"
      :description="t('designer.dataViewCardSettings.cardTitleHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="descriptionFormula"
      :label="t('designer.dataViewCardSettings.cardDescription')"
      :description="t('designer.dataViewCardSettings.cardDescriptionHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />
  </SettingsSection>
</template>
