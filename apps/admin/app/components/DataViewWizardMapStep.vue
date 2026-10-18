<script setup lang="ts">
// DataView wizard, MAP layout step: position (numeric Latitude/Longitude
// columns), popup content, optional per-row icon/color columns with a
// fixed fallback pin, and the view the map always opens at (never
// auto-fit - MapViewPicker.vue).
import { isNumericDataType } from '@totalbase/tb-catalog'
import { DEFAULT_MAP_PIN_ICON, type MapLayoutConfig, type MapViewConfig } from '~/types/dataview'
import type { RoleColor } from '~/types/permission'
import type { WizardColumn } from '~/utils/dataview-wizard-layouts'

const layout = defineModel<MapLayoutConfig>({ required: true })
const view = defineModel<MapViewConfig>('view', { required: true })
const props = defineProps<{ columns: WizardColumn[] }>()
const { t } = useI18n()

const field = useModelField(layout)
const latitudeColumn = field('latitudeColumn')
const longitudeColumn = field('longitudeColumn')
// Where each row is: one native `point` column, or a latitude/longitude pair
// (Specification_DataViews.md §5.4) - one or the other, never both.
const pointColumn = field('pointColumn')
const locationMode = computed<'pair' | 'point'>({
  get: () => (pointColumn.value ? 'point' : 'pair'),
  set: (mode) => {
    if (mode === 'point') {
      latitudeColumn.value = null
      longitudeColumn.value = null
      pointColumn.value = pointColumns.value[0]?.name ?? null
    } else {
      pointColumn.value = null
    }
  }
})
const LOCATION_MODES = computed(() => [
  { label: t('designer.dataViewWizardMapStep.locationModes.pair.label'), value: 'pair', description: t('designer.dataViewWizardMapStep.locationModes.pair.description') },
  { label: t('designer.dataViewWizardMapStep.locationModes.point.label'), value: 'point', description: t('designer.dataViewWizardMapStep.locationModes.point.description') }
])

const name = useFormulaColumn(field('nameFormula'))
const description = useFormulaColumn(field('descriptionFormula'))
const iconColumn = useFormulaColumn(field('iconFormula'))
const colorColumn = useFormulaColumn(field('colorFormula'))
const defaultIconField = field('defaultIcon')
const defaultColorField = field('defaultColor')
const defaultIcon = computed({
  get: () => defaultIconField.value,
  set: (value: string | undefined) => { defaultIconField.value = value ?? DEFAULT_MAP_PIN_ICON }
})
const defaultColor = computed({
  get: () => defaultColorField.value ?? undefined,
  // "No color" is stored as an explicit null - see types/dataview.ts's `itemColor`.
  set: (value: RoleColor | undefined) => { defaultColorField.value = value ?? null }
})

const numericColumns = computed(() => props.columns.filter(c => isNumericDataType(c.dataType)))
const pointColumns = computed(() => props.columns.filter(c => c.dataType === 'point'))
</script>

<template>
  <div class="flex flex-col gap-4">
    <URadioGroup
      v-model="locationMode"
      :items="LOCATION_MODES"
      orientation="horizontal"
      :aria-label="t('designer.dataViewWizardMapStep.location')"
    />
    <DataViewColumnSelect
      v-if="locationMode === 'point'"
      v-model="pointColumn"
      :label="t('designer.dataViewWizardMapStep.location')"
      :description="t('designer.dataViewWizardMapStep.locationHelp')"
      :options="pointColumns"
    />
    <div
      v-else
      class="grid grid-cols-2 gap-3"
    >
      <DataViewColumnSelect
        v-model="latitudeColumn"
        :label="t('designer.dataViewWizardMapStep.latitude')"
        :description="t('designer.dataViewWizardMapStep.numericHelp')"
        :options="numericColumns"
      />
      <DataViewColumnSelect
        v-model="longitudeColumn"
        :label="t('designer.dataViewWizardMapStep.longitude')"
        :description="t('designer.dataViewWizardMapStep.numericHelp')"
        :options="numericColumns"
      />
    </div>

    <UAlert
      v-if="locationMode === 'pair' && numericColumns.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewWizardMapStep.noNumeric')"
    />

    <DataViewColumnSelect
      v-model="name"
      :label="t('common.name')"
      :description="t('designer.dataViewWizardMapStep.nameHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="description"
      :label="t('common.description')"
      :description="t('designer.dataViewWizardMapStep.descriptionHelp')"
      :options="columns"
    />

    <div class="grid grid-cols-2 gap-3">
      <DataViewColumnSelect
        v-model="iconColumn"
        :label="t('designer.dataViewWizardMapStep.iconColumn')"
        :description="t('designer.dataViewWizardMapStep.iconColumnHelp')"
        :options="columns"
      />
      <DataViewColumnSelect
        v-model="colorColumn"
        :label="t('designer.dataViewWizardMapStep.colorColumn')"
        :description="t('designer.dataViewWizardMapStep.colorColumnHelp')"
        :options="columns"
      />
    </div>

    <div class="flex gap-3">
      <IconPickerField
        v-model="defaultIcon"
        :label="t('designer.dataViewWizardMapStep.defaultPinIcon')"
        options="lucide"
      />
      <ColorPickerField
        v-model="defaultColor"
        :label="t('designer.dataViewWizardMapStep.defaultPinColor')"
        allow-none
      />
    </div>
    <p class="-mt-2 text-xs text-muted">
      {{ t('designer.dataViewWizardMapStep.defaultsHelp') }}
    </p>

    <UFormField
      :label="t('designer.dataViewWizardMapStep.initialView')"
      :description="t('designer.dataViewWizardMapStep.initialViewHelp')"
    >
      <MapViewPicker v-model="view" />
    </UFormField>
  </div>
</template>
