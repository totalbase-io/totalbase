<script setup lang="ts">
// DataView settings, CALENDAR layout (`view_config.calendar_layout`).
// Date is a strict date/timestamp column picker; no image slot - an
// event chip has no room for one (types/dataview.ts).
import { isDateDataType } from '@totalbase/tb-catalog'
import type { CalendarLayoutConfig, CalendarViewMode } from '~/types/dataview'
import type { CatalogColumn, RoleColor } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'
import { columnOptions, columnFieldsOfType, type DataViewColumnField } from '~/utils/dataview-columns'

const layout = defineModel<CalendarLayoutConfig>({ required: true })
const props = defineProps<{
  columnFields: DataViewColumnField[]
  bindingColumns: CatalogColumn[]
  relations?: RelationDefinition[]
}>()
const { t } = useI18n()

const field = useModelField(layout)
const dateColumn = field('dateColumn')
const titleFormula = field('titleFormula')
const descriptionFormula = field('descriptionFormula')
const colorFormula = field('colorFormula')
const defaultView = field('defaultView')
const defaultColorField = field('defaultColor')
const defaultColor = computed({
  get: () => defaultColorField.value ?? undefined,
  // "No color" is stored as an explicit null - see types/dataview.ts's `itemColor`.
  set: (value: RoleColor | undefined) => { defaultColorField.value = value ?? null }
})

// Sunday/Monday only here; the config keeps the full 0-6, so a value set
// by hand survives an unrelated save (it shows as Sunday).
const WEEK_START_LABELS = computed<Record<0 | 1, string>>(() => ({ 0: t('designer.dataViewCalendarSettings.sunday'), 1: t('designer.dataViewCalendarSettings.monday') }))
const WEEK_START_OPTIONS: (0 | 1)[] = [0, 1]
const weekStartsOnField = field('weekStartsOn')
const weekStartsOn = computed<0 | 1>({
  get: () => weekStartsOnField.value === 1 ? 1 : 0,
  set: (value) => { weekStartsOnField.value = value }
})
const CALENDAR_VIEW_LABELS = computed<Record<CalendarViewMode, string>>(() => ({ month: t('designer.dataViewCalendarSettings.views.month'), week: t('designer.dataViewCalendarSettings.views.week'), day: t('designer.dataViewCalendarSettings.views.day'), agenda: t('designer.dataViewCalendarSettings.views.agenda') }))

const dateOptions = computed(() => columnOptions(columnFieldsOfType(props.columnFields, props.bindingColumns, isDateDataType)))
</script>

<template>
  <SettingsSection :title="t('designer.dataViewCalendarSettings.heading')">
    <DataViewColumnSelect
      v-model="dateColumn"
      :label="t('designer.dataViewCalendarSettings.date')"
      :description="t('designer.dataViewCalendarSettings.dateHelp')"
      :options="dateOptions"
      :validate="bindingColumns.length > 0"
    />

    <UAlert
      v-if="dateOptions.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewCalendarSettings.noDateColumns')"
    />

    <DataViewFormulaField
      v-model="titleFormula"
      :label="t('designer.dataViewCalendarSettings.eventTitle')"
      :description="t('designer.dataViewCalendarSettings.eventTitleHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="descriptionFormula"
      :label="t('designer.dataViewCalendarSettings.eventDescription')"
      :description="t('designer.dataViewCalendarSettings.eventDescriptionHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="colorFormula"
      :label="t('common.color')"
      :description="t('designer.dataViewCalendarSettings.colorHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <ColorPickerField
      v-model="defaultColor"
      :label="t('designer.dataViewCalendarSettings.defaultEventColor')"
      allow-none
    />

    <div class="grid grid-cols-2 gap-3">
      <UFormField :label="t('designer.dataViewCalendarSettings.weekStartsOn')">
        <USelectMenu
          v-model="weekStartsOn"
          :items="WEEK_START_OPTIONS"
          class="w-full"
        >
          <template #item-label="{ item }">
            {{ WEEK_START_LABELS[item as 0 | 1] }}
          </template>
          <template #default>
            {{ WEEK_START_LABELS[weekStartsOn] }}
          </template>
        </USelectMenu>
      </UFormField>
      <UFormField :label="t('designer.dataViewCalendarSettings.defaultView')">
        <USelectMenu
          v-model="defaultView"
          :items="(['month', 'week', 'day', 'agenda'] as const)"
          class="w-full"
        >
          <template #item-label="{ item }">
            {{ CALENDAR_VIEW_LABELS[item as CalendarViewMode] }}
          </template>
          <template #default>
            {{ CALENDAR_VIEW_LABELS[defaultView] }}
          </template>
        </USelectMenu>
      </UFormField>
    </div>
  </SettingsSection>
</template>
