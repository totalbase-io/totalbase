<script setup lang="ts">
/**
 * `UInputTime` adapter for a `time` COLUMN field - same reasoning as
 * `WidgetInputDate.vue` (its own doc comment), just reka-ui's `Time`
 * instead of `CalendarDate`. Postgres's own `time` column comes back
 * from the Data API as an `"HH:MM:SS"` string, which `parseTime`
 * accepts directly.
 *
 * Typed segment by segment, or picked: a clock button (`picker`, on by default) opens a popover beside the field,
 * as the date's calendar does - an hour column and a minute column, every `minuteStep` minutes. An hour keeps the
 * minutes already there; a minute closes it. Disabled, no button.
 */
import { Time, parseTime } from '@internationalized/date'
import { pickerHourCycle } from '~/utils/datetime-local'

const modelValue = defineModel<string | null | undefined>()
const props = withDefaults(defineProps<{
  disabled?: boolean
  /** The clock button - on unless turned off. */
  picker?: boolean
  /** The minutes the picker offers, every this many - the catalog's select gives it as text (a minute typed in between is kept). */
  minuteStep?: string | number
}>(), { picker: true, minuteStep: 5 })

const timeValue = computed<Time | undefined>({
  get() {
    if (!modelValue.value) return undefined
    try {
      return parseTime(modelValue.value)
    } catch {
      return undefined
    }
  },
  set(value) {
    modelValue.value = value instanceof Time ? value.toString() : null
  }
})

/** The UI's language - the order and separators the viewer reads dates in; not Nuxt UI's (en). */
const ui = useUiLocale()
// The picker's words: the UI's language.
const locale = computed(() => ui.languageTag.value)
const hourCycle = computed(() => pickerHourCycle(locale.value))
const { t } = useI18n()

const pickerOpen = ref(false)
const step = computed(() => {
  const value = Number(props.minuteStep)
  return Number.isInteger(value) && value >= 1 && value <= 30 ? value : 5
})
const hours = Array.from({ length: 24 }, (_, hour) => hour)
const minutes = computed(() => Array.from({ length: Math.ceil(60 / step.value) }, (_, i) => i * step.value))
/** An hour as the viewer reads it - "14" on a 24-hour clock, "2 p. m." on a 12-hour one. */
function hourLabel(hour: number): string {
  if (hourCycle.value !== 12) return String(hour).padStart(2, '0')
  return new Intl.DateTimeFormat(locale.value, { hour: 'numeric', hour12: true }).format(new Date(2000, 0, 1, hour))
}
function pickHour(hour: number) {
  timeValue.value = new Time(hour, timeValue.value?.minute ?? 0)
}
function pickMinute(minute: number) {
  timeValue.value = new Time(timeValue.value?.hour ?? 0, minute)
  pickerOpen.value = false
}

// Opened: the picked hour and minute scrolled into view.
const lists = ref<HTMLElement | null>(null)
watch(pickerOpen, async (open) => {
  if (!open) return
  await nextTick()
  lists.value?.querySelectorAll<HTMLElement>('[aria-pressed="true"]').forEach(el => el.scrollIntoView({ block: 'center' }))
})
</script>

<template>
  <UInputTime
    v-model="timeValue"
    :disabled="disabled"
    :locale="locale"
    :hour-cycle="hourCycle"
  >
    <template
      v-if="picker && !disabled"
      #trailing
    >
      <UPopover
        v-model:open="pickerOpen"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-clock"
          color="neutral"
          variant="link"
          size="sm"
          :aria-label="t('dataviews.widgetInputTime.openPicker')"
          class="px-0"
        />
        <template #content>
          <div
            ref="lists"
            class="flex gap-1 p-2"
          >
            <div
              class="flex max-h-56 flex-col gap-0.5 overflow-y-auto pe-1"
              role="group"
              :aria-label="t('dataviews.widgetInputTime.hours')"
            >
              <UButton
                v-for="hour in hours"
                :key="hour"
                :label="hourLabel(hour)"
                :color="timeValue?.hour === hour ? 'primary' : 'neutral'"
                :variant="timeValue?.hour === hour ? 'soft' : 'ghost'"
                :aria-pressed="timeValue?.hour === hour"
                size="sm"
                block
                @click="pickHour(hour)"
              />
            </div>
            <USeparator orientation="vertical" />
            <div
              class="flex max-h-56 flex-col gap-0.5 overflow-y-auto pe-1"
              role="group"
              :aria-label="t('dataviews.widgetInputTime.minutes')"
            >
              <UButton
                v-for="minute in minutes"
                :key="minute"
                :label="String(minute).padStart(2, '0')"
                :color="timeValue?.minute === minute ? 'primary' : 'neutral'"
                :variant="timeValue?.minute === minute ? 'soft' : 'ghost'"
                :aria-pressed="timeValue?.minute === minute"
                size="sm"
                block
                @click="pickMinute(minute)"
              />
            </div>
          </div>
        </template>
      </UPopover>
    </template>
  </UInputTime>
</template>
