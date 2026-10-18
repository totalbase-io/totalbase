<script setup lang="ts">
/**
 * `UInputTime` adapter for a `time` COLUMN field - same reasoning as
 * `WidgetInputDate.vue` (its own doc comment), just reka-ui's `Time`
 * instead of `CalendarDate`. Postgres's own `time` column comes back
 * from the Data API as an `"HH:MM:SS"` string, which `parseTime`
 * accepts directly.
 */
import { Time, parseTime } from '@internationalized/date'
import { pickerHourCycle } from '~/utils/datetime-local'

const modelValue = defineModel<string | null | undefined>()
defineProps<{ disabled?: boolean }>()

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
</script>

<template>
  <UInputTime
    v-model="timeValue"
    :disabled="disabled"
    :locale="locale"
    :hour-cycle="hourCycle"
  />
</template>
