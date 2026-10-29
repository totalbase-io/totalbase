<script setup lang="ts">
/**
 * My account > Preferences: the UI's language, and how numbers, dates and
 * times read for the signed-in user - the regional format and the timezone
 * (Security.md §4.2, Admin_UI.md §14). Each choice applies at
 * once (PATCH /app/api/me/preferences) - there's nothing to review before
 * saving a display setting - and "Instance default" clears it back to
 * Settings > General. The session's `display` is refreshed after each
 * change, so the whole portal (useDateTimeFormat) follows immediately.
 */
import type { MyPreferences, MyPreferencesState } from '~/types/security'
import { isRegionalFormat, REGIONAL_FORMATS, regionalFormatExample, regionalFormatLabel, UI_LANGUAGES } from '@totalbase/shared'
import { clockOptions, SHORT_DATE, SHORT_TIME } from '~/utils/datetime-local'
import { useApiErrorMessage } from '~/utils/api-error-message'

const appApi = useAppApi()
const session = useSession()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const ui = useUiLocale()

const { data: state, error } = await useAsyncData(
  'account-preferences',
  () => appApi.get<MyPreferencesState>('/me/preferences').then(r => r.data)
)

const DEFAULT = '__default__'

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const instance = computed(() => state.value?.instance)
/** The zone TotalBase shows times in when it isn't this browser's - the viewer should know. */
const otherZone = computed(() => {
  const zone = state.value?.effective.timezone
  return zone && zone !== browserZone ? zone : null
})

function defaultLabel(value: string | undefined, describe: (v: string) => string, empty: string) {
  return t('common.instanceDefault', { value: value ? describe(value) : empty })
}

// The UI's language (Admin_UI.md §14) - each in its own name.
const languageItems = computed(() => [
  { value: DEFAULT, label: t('account.preferences.language.instanceDefault', { language: UI_LANGUAGES.find(l => l.code === instance.value?.language)?.name ?? 'English' }) },
  ...UI_LANGUAGES.map(language => ({ value: language.code, label: language.name }))
])

const timezoneItems = computed(() => [
  { value: DEFAULT, label: defaultLabel(instance.value?.timezone, v => v, t('account.preferences.dateTime.browserZone', { zone: browserZone })) },
  ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC']).map(zone => ({ value: zone, label: zone }))
])
// The country first, in the UI's language - typing "Argentina" finds it.
const regionalItems = computed(() => {
  const browser = t('account.preferences.dateTime.browserFormat', { example: regionalFormatExample(new Intl.DateTimeFormat().resolvedOptions().locale) })
  const own = instance.value?.regionalFormat
  return [
    { value: DEFAULT, label: defaultLabel(own, v => isRegionalFormat(v) ? regionalFormatLabel(v, ui.languageTag.value) : v, browser) },
    ...REGIONAL_FORMATS.map(format => ({ value: format, label: regionalFormatLabel(format, ui.languageTag.value) }))
      .sort((a, b) => a.label.localeCompare(b.label, ui.languageTag.value))
  ]
})

const selected = (key: keyof MyPreferences) => state.value?.preferences[key] ?? DEFAULT

const saving = ref<keyof MyPreferences | null>(null)
async function choose(key: keyof MyPreferences, value: string) {
  if (value === selected(key)) return
  saving.value = key
  try {
    const { data } = await appApi.patch<MyPreferencesState>('/me/preferences', { data: { [key]: value === DEFAULT ? null : value } })
    state.value = data
    await session.refreshProfile()
  } catch (err) {
    notifyError(err, t('account.preferences.saveError'))
  } finally {
    saving.value = null
  }
}

// What a date-time reads like with the effective settings, right now.
const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => (now.value = new Date()), 30_000)
})
onBeforeUnmount(() => clearInterval(timer))
const preview = computed(() => {
  const effective = state.value?.effective
  if (!effective) return ''
  return now.value.toLocaleString(ui.intlLocale.value, { ...clockOptions(), ...SHORT_DATE, ...SHORT_TIME, timeZone: effective.timezone || browserZone })
})
</script>

<template>
  <PageShell>
    <UAlert
      v-if="error || !state"
      color="error"
      variant="subtle"
      :title="t('account.preferences.loadError')"
      :description="error ? errorMessage(error) : undefined"
    />
    <div
      v-else
      class="mx-auto flex w-full max-w-2xl flex-col gap-8"
    >
      <section class="flex flex-col gap-4">
        <h2 class="border-b border-default pb-2 text-base font-semibold text-highlighted">
          {{ t('account.preferences.language.title') }}
        </h2>
        <p class="text-sm text-muted">
          {{ t('account.preferences.language.intro') }}
        </p>
        <UFormField
          :label="t('account.preferences.language.label')"
          :description="t('account.preferences.language.description')"
        >
          <USelect
            :model-value="selected('language')"
            :items="languageItems"
            :loading="saving === 'language'"
            :aria-label="t('account.preferences.language.label')"
            class="w-full max-w-md"
            @update:model-value="(v: string) => choose('language', v)"
          />
        </UFormField>
      </section>
      <section class="flex flex-col gap-4">
        <h2 class="border-b border-default pb-2 text-base font-semibold text-highlighted">
          {{ t('account.preferences.dateTime.title') }}
        </h2>
        <p class="text-sm text-muted">
          {{ t('account.preferences.dateTime.intro') }}
        </p>
        <UFormField
          :label="t('account.preferences.dateTime.regionalFormat')"
          :description="t('account.preferences.dateTime.regionalFormatDescription')"
        >
          <USelectMenu
            :model-value="selected('regionalFormat')"
            :items="regionalItems"
            value-key="value"
            :search-input="{}"
            :loading="saving === 'regionalFormat'"
            :aria-label="t('account.preferences.dateTime.regionalFormat')"
            class="w-full max-w-md"
            @update:model-value="(v: string) => choose('regionalFormat', v)"
          />
        </UFormField>
        <UFormField
          :label="t('account.preferences.dateTime.timezone')"
          :description="state.timezoneLocked ? t('account.preferences.dateTime.timezoneLocked') : t('account.preferences.dateTime.timezoneDescription')"
        >
          <USelectMenu
            :model-value="state.timezoneLocked ? DEFAULT : selected('timezone')"
            :disabled="state.timezoneLocked"
            :items="timezoneItems"
            value-key="value"
            :search-input="{}"
            :loading="saving === 'timezone'"
            :aria-label="t('account.preferences.dateTime.timezone')"
            class="w-full max-w-md"
            @update:model-value="(v: string) => choose('timezone', v)"
          />
        </UFormField>
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-default px-4 py-3 text-sm">
          <span class="text-muted">{{ t('account.preferences.dateTime.readsAs') }}</span>
          <span class="font-medium text-highlighted">{{ preview }}</span>
          <span class="text-muted">{{ state.effective.timezone || browserZone }}</span>
        </div>
        <UAlert
          v-if="otherZone"
          color="info"
          variant="subtle"
          icon="i-lucide-globe"
          :title="t('account.preferences.dateTime.shownIn', { zone: otherZone })"
          :description="`${t('account.preferences.dateTime.browserIn', { zone: browserZone })} ${state.timezoneLocked ? t('account.preferences.dateTime.lockedForEveryone') : state.preferences.timezone ? t('account.preferences.dateTime.chosenAbove') : t('account.preferences.dateTime.instanceZone')}`"
        />
      </section>
    </div>
  </PageShell>
</template>
