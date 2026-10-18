// Cron expression builder from a readable preset (hourly/daily/weekly/
// monthly/custom) - for
// a workflow's CRON trigger (WorkflowTriggerFields.vue). Project-agnostic.
//
// The presets write month and weekday names where they read better
// (`0 9 * * MON-FRI`, `0 3 1 JAN,JUL *`); a custom expression is checked
// against the same grammar (utils/cron-expression.ts).
import { cronNameList, isValidCronExpression, MONTH_NAMES, WEEKDAY_NAMES } from '~/utils/cron-expression'

export interface CronOption {
  label: string
  short: string
  value: number
}

export const CRON_WEEKDAYS: CronOption[] = [
  { label: 'Sunday', short: 'S', value: 0 },
  { label: 'Monday', short: 'M', value: 1 },
  { label: 'Tuesday', short: 'T', value: 2 },
  { label: 'Wednesday', short: 'W', value: 3 },
  { label: 'Thursday', short: 'T', value: 4 },
  { label: 'Friday', short: 'F', value: 5 },
  { label: 'Saturday', short: 'S', value: 6 }
]

export const CRON_MONTHS: CronOption[] = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  .map((label, i) => ({ label, short: label.slice(0, 3), value: i + 1 }))

export type CronPreset = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM'

export function useCronScheduleBuilder(initial?: { preset?: CronPreset, expression?: string }) {
  // A saved expression isn't back-parsed into a preset (ambiguous in
  // general): it opens as Custom, unchanged, until the author picks a preset.
  const initialPreset = (): CronPreset => initial?.expression ? 'CUSTOM' : initial?.preset ?? 'DAILY'
  const preset = ref<CronPreset>(initialPreset())
  const time = ref('03:00')
  const minute = ref(0) // HOURLY only: minute of every hour
  const weekdays = ref<number[]>([1]) // 0=Sunday … 6=Saturday (standard cron)
  const monthday = ref(1)
  const months = ref<number[]>(CRON_MONTHS.map(m => m.value)) // MONTHLY only: every month by default
  const customCron = ref(initial?.expression ?? '')

  function toggleWeekday(day: number) {
    const idx = weekdays.value.indexOf(day)
    if (idx === -1) {
      weekdays.value = [...weekdays.value, day].sort((a, b) => a - b)
    } else if (weekdays.value.length > 1) {
      // At least one day must always remain selected.
      weekdays.value = weekdays.value.filter(d => d !== day)
    }
  }

  const cronExpression = computed(() => {
    if (preset.value === 'CUSTOM') return customCron.value.trim()
    if (preset.value === 'HOURLY') return `${minute.value} * * * *`
    const [hour, min] = time.value.split(':').map(Number)
    if (preset.value === 'DAILY') return `${min} ${hour} * * *`
    if (preset.value === 'WEEKLY') return `${min} ${hour} * * ${cronNameList(weekdays.value, WEEKDAY_NAMES, 0)}`
    const monthField = months.value.length === 0 || months.value.length === 12 ? '*' : cronNameList(months.value, MONTH_NAMES, 1)
    return `${min} ${hour} ${monthday.value} ${monthField} *` // MONTHLY
  })
  const customCronValid = computed(() => preset.value !== 'CUSTOM' || isValidCronExpression(customCron.value))
  const valid = computed(() => cronExpression.value.length > 0 && customCronValid.value)

  function reset() {
    preset.value = initialPreset()
    time.value = '03:00'
    minute.value = 0
    weekdays.value = [1]
    monthday.value = 1
    months.value = CRON_MONTHS.map(m => m.value)
    customCron.value = initial?.expression ?? ''
  }

  return { preset, time, minute, weekdays, monthday, months, customCron, toggleWeekday, cronExpression, customCronValid, valid, reset }
}
