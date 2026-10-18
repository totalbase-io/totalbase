<script setup lang="ts">
// Schedule picker -> cron expression, self-contained, for a
// workflow's CRON trigger (WorkflowTriggerFields.vue) - see
// composables/useCronScheduleBuilder.ts. Exposes only
// the final cron expression via v-model - the consumer doesn't need to
// know about preset/time/day.
//
// `timezone` (a second, separate prop, not part of the cron expression
// itself - `WorkflowTriggerFields.vue`'s own `cronConfig.timezone` field)
// is used only to fetch a real "next occurrences" preview from
// `GET /admin/api/workflows/cron/preview` (apps/server/src/workflow-
// execution/cron.ts's own `nextOccurrences()` - the exact schedule-
// matching logic the real dispatcher uses, not a client-side
// reimplementation) - replaces the old placeholder line that just echoed
// the cron expression string back as if it were itself a timestamp.
const props = defineProps<{
  modelValue: string
  timezone: string
  /** The saved workflow, when editing one - the preview also shows its last scheduled occurrence. */
  workflowId?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [string], 'update:valid': [boolean] }>()

// A saved expression opens as Custom, unchanged (never back-parsed into a preset).
const builder = useCronScheduleBuilder({ expression: props.modelValue || undefined })
const api = useAdminApi()
const { t } = useI18n()
const ui = useUiLocale()

// Weekday and month names in the UI's language (Intl), the values stay cron's.
const weekdayItems = computed(() => {
  const long = new Intl.DateTimeFormat(ui.languageTag.value, { weekday: 'long', timeZone: 'UTC' })
  const narrow = new Intl.DateTimeFormat(ui.languageTag.value, { weekday: 'narrow', timeZone: 'UTC' })
  // 2023-01-01 was a Sunday: day `value` (0 = Sunday) is 2023-01-0(1 + value).
  return CRON_WEEKDAYS.map((day) => {
    const date = new Date(Date.UTC(2023, 0, 1 + day.value))
    return { ...day, label: long.format(date), short: narrow.format(date).toLocaleUpperCase(ui.languageTag.value) }
  })
})
const monthItems = computed(() => {
  const long = new Intl.DateTimeFormat(ui.languageTag.value, { month: 'long', timeZone: 'UTC' })
  return CRON_MONTHS.map(month => ({ ...month, label: long.format(new Date(Date.UTC(2023, month.value - 1, 1))) }))
})
const presetItems = computed(() => [
  { label: t('workflows.cron.hourly'), value: 'HOURLY' },
  { label: t('workflows.cron.daily'), value: 'DAILY' },
  { label: t('workflows.cron.weekly'), value: 'WEEKLY' },
  { label: t('workflows.cron.monthly'), value: 'MONTHLY' },
  { label: t('workflows.cron.custom'), value: 'CUSTOM' }
])

watch(
  builder.cronExpression,
  (expr) => {
    emit('update:modelValue', expr)
    emit('update:valid', builder.valid.value)
  },
  { immediate: true }
)

const occurrences = ref<string[]>([])
const lastOccurrence = ref<string | null>(null)
const previewError = ref<string | null>(null)
let previewToken = 0

async function loadPreview() {
  const token = ++previewToken
  occurrences.value = []
  previewError.value = null
  if (!builder.valid.value || !props.timezone) return
  try {
    const { data } = await api.get<{ occurrences: string[], lastOccurrence?: string | null }>('/workflows/cron/preview', {
      expression: builder.cronExpression.value, timezone: props.timezone, count: 3,
      ...(props.workflowId && { workflow: props.workflowId })
    })
    if (token !== previewToken) return
    occurrences.value = data.occurrences
    lastOccurrence.value = data.lastOccurrence ?? null
  } catch {
    if (token !== previewToken) return
    previewError.value = t('workflows.cron.previewFailed')
  }
}

watch([builder.cronExpression, () => props.timezone, builder.valid], loadPreview, { immediate: true })

const formatter = computed(() => props.timezone
  ? new Intl.DateTimeFormat(ui.intlLocale.value, { timeZone: props.timezone, dateStyle: 'medium', timeStyle: 'short' })
  : undefined)
function formatOccurrence(iso: string): string {
  return formatter.value ? formatter.value.format(new Date(iso)) : iso
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <URadioGroup
      v-model="builder.preset.value"
      orientation="horizontal"
      :items="presetItems"
    />

    <UFormField
      v-if="builder.preset.value === 'HOURLY'"
      :label="t('workflows.cron.minuteOfHour')"
    >
      <UInput
        v-model.number="builder.minute.value"
        type="number"
        min="0"
        max="59"
        class="w-32"
      />
    </UFormField>

    <UFormField
      v-if="['DAILY', 'WEEKLY', 'MONTHLY'].includes(builder.preset.value)"
      :label="t('workflows.cron.time')"
    >
      <UInput
        v-model="builder.time.value"
        type="time"
        class="w-40"
      />
    </UFormField>

    <UFormField
      v-if="builder.preset.value === 'WEEKLY'"
      :label="t('workflows.cron.daysOfWeek')"
    >
      <div class="flex gap-1.5">
        <UButton
          v-for="day in weekdayItems"
          :key="day.value"
          :label="day.short"
          :aria-label="day.label"
          :color="builder.weekdays.value.includes(day.value) ? 'primary' : 'neutral'"
          :variant="builder.weekdays.value.includes(day.value) ? 'solid' : 'outline'"
          size="sm"
          square
          @click="builder.toggleWeekday(day.value)"
        />
      </div>
    </UFormField>

    <UFormField
      v-if="builder.preset.value === 'MONTHLY'"
      :label="t('workflows.cron.months')"
      :description="t('workflows.cron.monthsDescription')"
    >
      <USelectMenu
        v-model="builder.months.value"
        :aria-label="t('workflows.cron.months')"
        :items="monthItems"
        value-key="value"
        label-key="label"
        multiple
        class="w-full"
      />
    </UFormField>

    <UFormField
      v-if="builder.preset.value === 'MONTHLY'"
      :label="t('workflows.cron.dayOfMonth')"
    >
      <UInput
        v-model.number="builder.monthday.value"
        type="number"
        min="1"
        max="31"
        class="w-32"
      />
    </UFormField>

    <UFormField
      v-if="builder.preset.value === 'CUSTOM'"
      :label="t('workflows.cron.expression')"
      :description="t('workflows.cron.expressionDescription', { example: '0 9 * * MON-FRI' })"
      :error="builder.customCron.value && !builder.customCronValid.value ? t('workflows.cron.invalid') : undefined"
    >
      <UInput
        v-model="builder.customCron.value"
        class="w-full font-mono"
      />
    </UFormField>

    <div class="text-xs text-muted">
      <p
        v-if="workflowId"
        class="mb-2"
      >
        {{ t('workflows.cron.lastOccurrence') }} <span class="font-mono">{{ lastOccurrence ? formatOccurrence(lastOccurrence) : '—' }}</span>
      </p>
      <p v-if="previewError">
        {{ previewError }}
      </p>
      <template v-else-if="occurrences.length > 0">
        <p class="mb-1">
          {{ t('workflows.cron.nextRunsIn', { timezone }) }}
        </p>
        <ul class="space-y-0.5 font-mono">
          <li
            v-for="iso in occurrences"
            :key="iso"
          >
            {{ formatOccurrence(iso) }}
          </li>
        </ul>
      </template>
      <p v-else>
        {{ t('workflows.cron.nextRunsNone') }}
      </p>
    </div>
  </div>
</template>
