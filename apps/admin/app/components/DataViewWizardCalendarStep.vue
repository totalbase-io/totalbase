<script setup lang="ts">
// DataView wizard, CALENDAR layout step: the one date/timestamp column
// that places each row (never a start/end pair - that's GANTT), each
// event's content and color, week start and default view.
import { isDateDataType } from '@totalbase/tb-catalog'
import type { CalendarLayoutConfig, CalendarViewMode } from '~/types/dataview'
import type { RoleColor } from '~/types/permission'
import type { WizardColumn } from '~/utils/dataview-wizard-layouts'

const layout = defineModel<CalendarLayoutConfig>({ required: true })
const props = defineProps<{ columns: WizardColumn[] }>()
const { t } = useI18n()

const field = useModelField(layout)
const dateColumn = field('dateColumn')
const title = useFormulaColumn(field('titleFormula'))
const description = useFormulaColumn(field('descriptionFormula'))
const colorColumn = useFormulaColumn(field('colorFormula'))
const defaultView = field('defaultView')
const defaultColorField = field('defaultColor')
const defaultColor = computed({
  get: () => defaultColorField.value ?? undefined,
  // "No color" is stored as an explicit null - see types/dataview.ts's `itemColor`.
  set: (value: RoleColor | undefined) => { defaultColorField.value = value ?? null }
})
// Sunday/Monday only - the stored type allows 0-6, reachable by editing view_config.
const WEEK_START_LABELS = computed<Record<0 | 1, string>>(() => ({ 0: t('designer.dataViewWizardCalendarStep.sunday'), 1: t('designer.dataViewWizardCalendarStep.monday') }))
const weekStartsOnField = field('weekStartsOn')
const weekStartsOn = computed<0 | 1>({
  get: () => weekStartsOnField.value === 1 ? 1 : 0,
  set: (value) => { weekStartsOnField.value = value }
})
const CALENDAR_VIEW_LABELS = computed<Record<CalendarViewMode, string>>(() => ({ month: t('designer.dataViewWizardCalendarStep.views.month'), week: t('designer.dataViewWizardCalendarStep.views.week'), day: t('designer.dataViewWizardCalendarStep.views.day'), agenda: t('designer.dataViewWizardCalendarStep.views.agenda') }))

const dateColumns = computed(() => props.columns.filter(c => isDateDataType(c.dataType)))
</script>

<template>
  <div class="flex flex-col gap-4">
    <DataViewColumnSelect
      v-model="dateColumn"
      :label="t('designer.dataViewWizardCalendarStep.date')"
      :description="t('designer.dataViewWizardCalendarStep.dateHelp')"
      :options="dateColumns"
    />

    <UAlert
      v-if="dateColumns.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewWizardCalendarStep.noDateColumns')"
    />

    <DataViewColumnSelect
      v-model="title"
      :label="t('designer.dataViewWizardCalendarStep.eventTitle')"
      :description="t('designer.dataViewWizardCalendarStep.eventTitleHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="description"
      :label="t('designer.dataViewWizardCalendarStep.eventDescription')"
      :description="t('designer.dataViewWizardCalendarStep.eventDescriptionHelp')"
      :options="columns"
    />
    <DataViewColumnSelect
      v-model="colorColumn"
      :label="t('designer.dataViewWizardCalendarStep.colorColumn')"
      :description="t('designer.dataViewWizardCalendarStep.colorColumnHelp')"
      :options="columns"
    />

    <ColorPickerField
      v-model="defaultColor"
      :label="t('designer.dataViewWizardCalendarStep.defaultEventColor')"
      allow-none
    />
    <p class="-mt-2 text-xs text-muted">
      {{ t('designer.dataViewWizardCalendarStep.defaultColorHelp') }}
    </p>

    <div class="grid grid-cols-2 gap-3">
      <UFormField :label="t('designer.dataViewWizardCalendarStep.weekStartsOn')">
        <USelectMenu
          v-model="weekStartsOn"
          :items="([0, 1] as const)"
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
      <UFormField :label="t('designer.dataViewWizardCalendarStep.defaultView')">
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
  </div>
</template>
