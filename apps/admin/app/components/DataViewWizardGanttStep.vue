<script setup lang="ts">
// DataView wizard, GANTT layout step: Start/End date columns, an optional
// foreign key that groups bars into swimlanes (a flat timeline is a real
// Gantt too), each bar's content and color, and the default zoom.
import { isDateDataType } from '@totalbase/tb-catalog'
import { GANTT_ZOOM_META, type GanttLayoutConfig, type GanttZoom } from '~/types/dataview'
import type { RoleColor } from '~/types/permission'
import type { WizardColumn } from '~/utils/dataview-wizard-layouts'

const layout = defineModel<GanttLayoutConfig>({ required: true })
const props = defineProps<{ columns: WizardColumn[] }>()
const { t } = useI18n()
const catalogText = useCatalogText()
/** GANTT_ZOOM_META, in the UI's language. */
const zoomLabel = (zoom: GanttZoom) => catalogText(`designer.dataViewWizardGanttStep.zoom.${zoom}`, GANTT_ZOOM_META[zoom].label)

const field = useModelField(layout)
const startDateColumn = field('startDateColumn')
const endDateColumn = field('endDateColumn')
const groupColumn = field('groupColumn')
const title = useFormulaColumn(field('titleFormula'))
const description = useFormulaColumn(field('descriptionFormula'))
const colorColumn = useFormulaColumn(field('colorFormula'))
const defaultZoom = field('defaultZoom')
const defaultColorField = field('defaultColor')
const defaultColor = computed({
  get: () => defaultColorField.value ?? undefined,
  // "No color" is stored as an explicit null - see types/dataview.ts's `itemColor`.
  set: (value: RoleColor | undefined) => { defaultColorField.value = value ?? null }
})

const dateColumns = computed(() => props.columns.filter(c => isDateDataType(c.dataType)))
const foreignKeyColumns = computed(() => props.columns.filter(c => c.isForeignKey))
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-2 gap-3">
      <DataViewColumnSelect
        v-model="startDateColumn"
        :label="t('designer.dataViewWizardGanttStep.startDate')"
        :description="t('designer.dataViewWizardGanttStep.dateHelp')"
        :options="dateColumns"
      />
      <DataViewColumnSelect
        v-model="endDateColumn"
        :label="t('designer.dataViewWizardGanttStep.endDate')"
        :description="t('designer.dataViewWizardGanttStep.dateHelp')"
        :options="dateColumns"
      />
    </div>

    <UAlert
      v-if="dateColumns.length < 2"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewWizardGanttStep.fewDates')"
    />

    <DataViewColumnSelect
      v-model="groupColumn"
      :label="t('designer.dataViewWizardGanttStep.groupBy')"
      :description="t('designer.dataViewWizardGanttStep.groupByHelp')"
      :options="foreignKeyColumns"
    />
    <DataViewColumnSelect
      v-model="title"
      :label="t('designer.dataViewWizardGanttStep.barTitle')"
      :description="t('designer.dataViewWizardGanttStep.barTitleHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="description"
      :label="t('designer.dataViewWizardGanttStep.barDescription')"
      :description="t('designer.dataViewWizardGanttStep.barDescriptionHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="colorColumn"
      :label="t('designer.dataViewWizardGanttStep.colorColumn')"
      :description="t('designer.dataViewWizardGanttStep.colorColumnHelp')"
      :options="columns"
    />

    <ColorPickerField
      v-model="defaultColor"
      :label="t('designer.dataViewWizardGanttStep.defaultBarColor')"
      allow-none
    />
    <p class="-mt-2 text-xs text-muted">
      {{ t('designer.dataViewWizardGanttStep.defaultColorHelp') }}
    </p>

    <UFormField
      :label="t('designer.dataViewWizardGanttStep.defaultZoom')"
      :description="t('designer.dataViewWizardGanttStep.defaultZoomHelp')"
    >
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
</template>
