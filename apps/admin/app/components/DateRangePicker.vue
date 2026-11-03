<script setup lang="ts">
/**
 * A DATE_RANGE variable's one control (Dashboards.md §3.7, Admin_UI.md §6.1):
 * a button that reads the range in effect - a preset's name, or the custom
 * range in the viewer's regional format - and opens the picker
 * (DateRangePickerPanel): quick ranges beside the custom range. A popover on
 * a desktop or a tablet; on a phone the same panel in a bottom drawer, where
 * a popover holding a calendar positions badly.
 *
 * Props-driven, as the bar is: the host owns the value.
 */
import type { DashboardRunTimezone, DashboardVariable, DateRangeValue } from '~/types/dashboard'
import { dateRangeLabel } from '~/utils/dashboard-variables'
import { useDashboardCatalogText } from '~/types/dashboard'

const props = defineProps<{
  variable: DashboardVariable
  /** The range in effect - a preset, a custom range, or null (unset: no bounds). */
  modelValue: DateRangeValue | null
  /** The zone the last run used (`meta.timezone`) - shown at the picker's foot. */
  runTimezone?: DashboardRunTimezone | null
}>()
const emit = defineEmits<{ 'update:modelValue': [value: DateRangeValue] }>()
const { t } = useI18n()
const ui = useUiLocale()
const catalog = useDashboardCatalogText()
const isMobile = useIsMobile()

const open = ref(false)
const label = computed(() => dateRangeLabel(props.variable, props.modelValue, ui.intlLocale.value, catalog.presetLabel))

function pick(value: DateRangeValue) {
  emit('update:modelValue', value)
  open.value = false
}
</script>

<template>
  <UPopover
    v-if="!isMobile"
    v-model:open="open"
    :content="{ align: 'start' }"
  >
    <UButton
      icon="i-lucide-calendar-range"
      trailing-icon="i-lucide-chevron-down"
      :label="label"
      color="neutral"
      variant="outline"
      size="sm"
      :aria-label="t('dashboards.rangePicker.open', { label: variable.label })"
    />
    <template #content>
      <!-- Keyed by opening: the panel starts from the value in effect each time. -->
      <DateRangePickerPanel
        v-if="open"
        :variable="variable"
        :model-value="modelValue"
        :run-timezone="runTimezone"
        class="p-3"
        @pick="pick"
        @cancel="open = false"
      />
    </template>
  </UPopover>
  <template v-else>
    <UButton
      icon="i-lucide-calendar-range"
      trailing-icon="i-lucide-chevron-down"
      :label="label"
      color="neutral"
      variant="outline"
      size="sm"
      :aria-label="t('dashboards.rangePicker.open', { label: variable.label })"
      @click="open = true"
    />
    <UDrawer
      v-model:open="open"
      :title="variable.label"
      :description="variable.description"
    >
      <template #body>
        <DateRangePickerPanel
          v-if="open"
          :variable="variable"
          :model-value="modelValue"
          :run-timezone="runTimezone"
          @pick="pick"
          @cancel="open = false"
        />
      </template>
    </UDrawer>
  </template>
</template>
