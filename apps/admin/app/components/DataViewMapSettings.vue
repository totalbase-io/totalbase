<script setup lang="ts">
// DataView settings, MAP layout (`view_config.map_layout` and
// `map_view`). Latitude/Longitude stay strict numeric column pickers - a
// coordinate never combines columns; name/description/icon/color are
// formulas.
import { isNumericDataType } from '@totalbase/tb-catalog'
import { DEFAULT_MAP_PIN_ICON, type MapLayoutConfig, type MapViewConfig } from '~/types/dataview'
import type { CatalogColumn, RoleColor } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'
import { columnOptions, columnFieldsOfType, type DataViewColumnField } from '~/utils/dataview-columns'

const layout = defineModel<MapLayoutConfig>({ required: true })
const view = defineModel<MapViewConfig>('view', { required: true })
const props = defineProps<{
  columnFields: DataViewColumnField[]
  bindingColumns: CatalogColumn[]
  relations?: RelationDefinition[]
}>()
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
      pointColumn.value = pointOptions.value[0]?.name ?? null
    } else {
      pointColumn.value = null
    }
  }
})
const LOCATION_MODES = computed(() => [
  { label: t('designer.dataViewMapSettings.locationModes.pair.label'), value: 'pair', description: t('designer.dataViewMapSettings.locationModes.pair.description') },
  { label: t('designer.dataViewMapSettings.locationModes.point.label'), value: 'point', description: t('designer.dataViewMapSettings.locationModes.point.description') }
])

const nameFormula = field('nameFormula')
const descriptionFormula = field('descriptionFormula')
const iconFormula = field('iconFormula')
const colorFormula = field('colorFormula')
const defaultIconField = field('defaultIcon')
const defaultColorField = field('defaultColor')
// The pickers can clear their value; the config keeps a real pin.
const defaultIcon = computed({
  get: () => defaultIconField.value,
  set: (value: string | undefined) => { defaultIconField.value = value ?? DEFAULT_MAP_PIN_ICON }
})
const defaultColor = computed({
  get: () => defaultColorField.value ?? undefined,
  // "No color" is stored as an explicit null - see types/dataview.ts's `itemColor`.
  set: (value: RoleColor | undefined) => { defaultColorField.value = value ?? null }
})

const numericOptions = computed(() => columnOptions(columnFieldsOfType(props.columnFields, props.bindingColumns, isNumericDataType)))
const pointOptions = computed(() => columnOptions(columnFieldsOfType(props.columnFields, props.bindingColumns, dataType => dataType === 'point')))
</script>

<template>
  <SettingsSection :title="t('designer.dataViewMapSettings.heading')">
    <URadioGroup
      v-model="locationMode"
      :items="LOCATION_MODES"
      orientation="horizontal"
      :aria-label="t('designer.dataViewMapSettings.location')"
    />
    <DataViewColumnSelect
      v-if="locationMode === 'point'"
      v-model="pointColumn"
      :label="t('designer.dataViewMapSettings.location')"
      :description="t('designer.dataViewMapSettings.locationHelp')"
      :options="pointOptions"
    />
    <div
      v-else
      class="grid grid-cols-2 gap-3"
    >
      <DataViewColumnSelect
        v-model="latitudeColumn"
        :label="t('designer.dataViewMapSettings.latitude')"
        :description="t('designer.dataViewMapSettings.numericHelp')"
        :options="numericOptions"
        :validate="bindingColumns.length > 0"
      />
      <DataViewColumnSelect
        v-model="longitudeColumn"
        :label="t('designer.dataViewMapSettings.longitude')"
        :description="t('designer.dataViewMapSettings.numericHelp')"
        :options="numericOptions"
        :validate="bindingColumns.length > 0"
      />
    </div>

    <DataViewFormulaField
      v-model="nameFormula"
      :label="t('designer.dataViewMapSettings.popupName')"
      :description="t('designer.dataViewMapSettings.popupNameHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="descriptionFormula"
      :label="t('designer.dataViewMapSettings.popupDescription')"
      :description="t('designer.dataViewMapSettings.popupDescriptionHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="iconFormula"
      :label="t('common.icon')"
      :description="t('designer.dataViewMapSettings.iconHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="colorFormula"
      :label="t('common.color')"
      :description="t('designer.dataViewMapSettings.colorHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <div class="flex gap-3">
      <IconPickerField
        v-model="defaultIcon"
        :label="t('designer.dataViewMapSettings.defaultPinIcon')"
        options="lucide"
      />
      <ColorPickerField
        v-model="defaultColor"
        :label="t('designer.dataViewMapSettings.defaultPinColor')"
        allow-none
      />
    </div>

    <UFormField
      :label="t('designer.dataViewMapSettings.initialView')"
      :description="t('designer.dataViewMapSettings.initialViewHelp')"
    >
      <MapViewPicker v-model="view" />
    </UFormField>
  </SettingsSection>
</template>
