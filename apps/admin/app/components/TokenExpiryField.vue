<script setup lang="ts">
/**
 * A personal access token's lifetime - preset durations or a custom date,
 * with the resulting expiry spelled out below. Shared by TokensTable's
 * New token form and its Regenerate dialog. The model is whole days from
 * now (the API's `ttlDays`), null while the choice isn't valid yet.
 */
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()
const props = defineProps<{
  /** `api_keys.default_ttl_days` - preselected, and marked "(default)". */
  defaultDays: number
}>()
const ttlDays = defineModel<number | null>({ required: true })

const { t } = useI18n()

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DAYS = 3650

function isoDay(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function formatDay(date: Date) {
  return dates.date(date, TOKEN_DAY)
}

const minDate = isoDay(new Date(Date.now() + DAY_MS))
const maxDate = isoDay(new Date(Date.now() + MAX_DAYS * DAY_MS))

/** Days as a string (USelect value), or 'custom' for the date input. */
const choice = ref(String(props.defaultDays))
const customDate = ref('')

const duration = (days: number) => days === 365 ? t('users.tokenExpiry.oneYear') : t('users.tokenExpiry.days', { n: days })

const options = computed(() => {
  const days = [...new Set([7, 30, 90, 365, props.defaultDays])].sort((a, b) => a - b)
  return [
    ...days.map(d => ({
      label: d === props.defaultDays ? t('users.tokenExpiry.default', { duration: duration(d) }) : duration(d),
      value: String(d)
    })),
    { label: t('users.tokenExpiry.customDate'), value: 'custom' }
  ]
})

watchEffect(() => {
  if (choice.value !== 'custom') {
    ttlDays.value = Number(choice.value) || null
    return
  }
  if (!customDate.value) {
    ttlDays.value = null
    return
  }
  const [y, m, d] = customDate.value.split('-').map(Number)
  const days = Math.ceil((new Date(y!, m! - 1, d!).getTime() - Date.now()) / DAY_MS)
  ttlDays.value = days >= 1 && days <= MAX_DAYS ? days : null
})

const hint = computed(() => ttlDays.value
  ? t('users.tokenExpiry.stopsOn', { date: formatDay(new Date(Date.now() + ttlDays.value * DAY_MS)) })
  : t('users.tokenExpiry.pickDate', { date: formatDay(new Date(maxDate)) }))
</script>

<template>
  <UFormField
    :label="t('users.tokenExpiry.label')"
    required
    :description="hint"
  >
    <div class="flex flex-col gap-2 sm:flex-row">
      <USelect
        v-model="choice"
        :items="options"
        class="w-full sm:w-56"
      />
      <UInput
        v-if="choice === 'custom'"
        v-model="customDate"
        type="date"
        :min="minDate"
        :max="maxDate"
        class="w-full sm:w-48"
      />
    </div>
  </UFormField>
</template>
