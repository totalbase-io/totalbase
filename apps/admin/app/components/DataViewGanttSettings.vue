<script setup lang="ts">
// DataView settings, GANTT layout (`view_config.gantt_layout`). Start/End
// are strict date/timestamp pickers; Group by is Kanban's FK picker but
// optional - a flat timeline is a real Gantt too. Lane color and lane
// order only apply once a Group by column is mapped.
import { isDateDataType, isNumericDataType } from '@totalbase/tb-catalog'
import { GANTT_ZOOM_META, isForeignKeyField, type GanttLayoutConfig, type GanttZoom } from '~/types/dataview'
import type { CatalogColumn, RoleColor } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'
import { columnOptions, columnFieldsOfType, type DataViewColumnField } from '~/utils/dataview-columns'

const layout = defineModel<GanttLayoutConfig>({ required: true })
const props = defineProps<{
  columnFields: DataViewColumnField[]
  bindingColumns: CatalogColumn[]
  relations?: RelationDefinition[]
}>()
const { t } = useI18n()
const catalogText = useCatalogText()
/** GANTT_ZOOM_META, in the UI's language. */
const zoomLabel = (zoom: GanttZoom) => catalogText(`designer.dataViewGanttSettings.zoom.${zoom}`, GANTT_ZOOM_META[zoom].label)

const field = useModelField(layout)
const startDateColumn = field('startDateColumn')
const endDateColumn = field('endDateColumn')
const groupColumn = field('groupColumn')
const titleFormula = field('titleFormula')
const descriptionFormula = field('descriptionFormula')
const colorFormula = field('colorFormula')
const defaultZoom = field('defaultZoom')
const laneOrder = field('laneOrder')
const defaultColorField = field('defaultColor')
const defaultColor = computed({
  get: () => defaultColorField.value ?? undefined,
  // "No color" is stored as an explicit null - see types/dataview.ts's `itemColor`.
  set: (value: RoleColor | undefined) => { defaultColorField.value = value ?? null }
})
const laneColorColumn = field('laneColorColumn')
const laneOrderColumn = field('laneOrderColumn')
const progressColumn = field('progressColumn')

const dateOptions = computed(() => columnOptions(columnFieldsOfType(props.columnFields, props.bindingColumns, isDateDataType)))
const numericOptions = computed(() => columnOptions(columnFieldsOfType(props.columnFields, props.bindingColumns, isNumericDataType)))
const foreignKeyOptions = computed(() => columnOptions(props.columnFields.filter(isForeignKeyField)))
</script>

<template>
  <SettingsSection :title="t('designer.dataViewGanttSettings.heading')">
    <div class="grid grid-cols-2 gap-3">
      <DataViewColumnSelect
        v-model="startDateColumn"
        :label="t('designer.dataViewGanttSettings.startDate')"
        :description="t('designer.dataViewGanttSettings.dateHelp')"
        :options="dateOptions"
        :validate="bindingColumns.length > 0"
      />
      <DataViewColumnSelect
        v-model="endDateColumn"
        :label="t('designer.dataViewGanttSettings.endDate')"
        :description="t('designer.dataViewGanttSettings.dateHelp')"
        :options="dateOptions"
        :validate="bindingColumns.length > 0"
      />
    </div>

    <UAlert
      v-if="dateOptions.length < 2"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewGanttSettings.fewDates')"
    />

    <DataViewColumnSelect
      v-model="progressColumn"
      :label="t('designer.dataViewGanttSettings.progress')"
      :description="t('designer.dataViewGanttSettings.progressHelp')"
      :options="numericOptions"
      :validate="bindingColumns.length > 0"
    />

    <DataViewColumnSelect
      v-model="groupColumn"
      :label="t('designer.dataViewGanttSettings.groupBy')"
      :description="t('designer.dataViewGanttSettings.groupByHelp')"
      :options="foreignKeyOptions"
      :validate="bindingColumns.length > 0"
    />

    <DataViewFormulaField
      v-model="titleFormula"
      :label="t('designer.dataViewGanttSettings.barTitle')"
      :description="t('designer.dataViewGanttSettings.barTitleHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="descriptionFormula"
      :label="t('designer.dataViewGanttSettings.barDescription')"
      :description="t('designer.dataViewGanttSettings.barDescriptionHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="colorFormula"
      :label="t('common.color')"
      :description="t('designer.dataViewGanttSettings.colorHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <div class="grid grid-cols-2 gap-3">
      <ColorPickerField
        v-model="defaultColor"
        :label="t('designer.dataViewGanttSettings.defaultBarColor')"
        allow-none
      />
      <UFormField :label="t('designer.dataViewGanttSettings.defaultZoom')">
        <USelectMenu
          v-model="defaultZoom"
          :items="(['day', 'week', 'month'] as const)"
          class="w-full"
        >
          <template #item-label="{ item }">
            {{ zoomLabel(item as GanttZoom) }}
          </template>
          <template #default>
            {{ zoomLabel(defaultZoom) }}
          </template>
        </USelectMenu>
      </UFormField>
    </div>

    <template v-if="groupColumn">
      <DataViewLaneColumns
        v-model:order-column="laneOrderColumn"
        v-model:color-column="laneColorColumn"
        :group-column="groupColumn"
        :relations="relations"
      />

      <DataViewLaneOrder
        v-model="laneOrder"
        :group-column="groupColumn"
        :relations="relations"
        :fields="columnFields"
        :order-column="laneOrderColumn"
        :description="t('designer.dataViewGanttSettings.laneOrderHelp')"
        :empty-text="t('designer.dataViewGanttSettings.noLanes')"
      />
    </template>
  </SettingsSection>
</template>
