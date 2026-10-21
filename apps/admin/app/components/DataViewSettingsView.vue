<script setup lang="ts">
/**
 * A SETTINGS DataView (DataViews.md §5.12): a parameter table laid out like TotalBase's own
 * Settings - a section per group, a row per setting (its title, its description, its value's control),
 * edited in place and saved per section. No New or Delete: the settings come with the installation.
 *
 * Every read and write is the viewer's, through the Data API; which rows they may change comes from the
 * Permission Resolver (`/app/api/dataviews/:slug/settings-writable`) - a row they can't change shows locked.
 * PostgreSQL validates (a CHECK, a trigger's RAISE): its message shows under the setting that failed.
 *
 * Config arrives as props (AGENTS.md §21A) - the page hosting it resolves the DataView.
 */
import type { SettingsLayoutConfig } from '~/types/dataview'

const props = defineProps<{
  dataviewSlug: string
  schema: string
  resourceName: string
  /** A view's rows are read only. */
  resourceKind: 'table' | 'view'
  primaryKey: string | null
  layout: SettingsLayoutConfig
  /** The search box (feature `search`). */
  searchable: boolean
}>()

const { t } = useI18n()
const toast = useToast()
const dataApi = useDataApi()
const appApi = useAppApi()
const errorMessage = useApiErrorMessage()

interface SettingRow {
  pk: string
  key: string
  value: unknown
  title: string
  description: string
  group: string
  order: number | null
}
type Kind = 'number' | 'boolean' | 'date' | 'text' | 'json'

const rows = ref<SettingRow[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const writable = ref<{ valueWritable: boolean, keys: string[] | null }>({ valueWritable: false, keys: [] })
/** Unsaved values, by key - what the controls show; a key not here shows its saved value. */
const drafts = reactive(new Map<string, unknown>())
/** PostgreSQL's refusal, under the setting it refused. */
const errors = reactive(new Map<string, string>())
const savingGroup = ref<string | null>(null)
const search = ref('')

const col = computed(() => props.layout)
async function load() {
  loading.value = true
  loadError.value = null
  const l = col.value
  const columns = [props.primaryKey, l.keyColumn, l.valueColumn, l.titleColumn, l.descriptionColumn, l.groupColumn, l.orderColumn].filter((c): c is string => Boolean(c))
  try {
    const [data, access] = await Promise.all([
      dataApi.getAll<Record<string, unknown>>(dataApi.resourcePath(props.schema, props.resourceName, props.resourceKind), { fields: [...new Set(columns)].join(',') }),
      props.resourceKind === 'table'
        ? appApi.get<{ valueWritable: boolean, keys: string[] | null }>(`/dataviews/${props.dataviewSlug}/settings-writable`).then(r => r.data)
        : Promise.resolve({ valueWritable: false, keys: [] })
    ])
    rows.value = data.map(row => ({
      pk: String(row[props.primaryKey ?? l.keyColumn!]),
      key: String(row[l.keyColumn!]),
      value: row[l.valueColumn!],
      title: row[l.titleColumn!] == null ? String(row[l.keyColumn!]) : String(row[l.titleColumn!]),
      description: row[l.descriptionColumn!] == null ? '' : String(row[l.descriptionColumn!]),
      group: l.groupColumn && row[l.groupColumn] != null ? String(row[l.groupColumn]) : '',
      order: l.orderColumn && typeof row[l.orderColumn] === 'number' ? row[l.orderColumn] as number : null
    }))
    writable.value = access
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** Its control, from its value's JSON type: a number, a switch, a date (YYYY-MM-DD), text - an object or a list as JSON. */
function kindOf(value: unknown): Kind {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'date' : 'text'
  if (value !== null && typeof value === 'object') return 'json'
  return 'text'
}
const isLocked = (row: SettingRow) => !writable.value.valueWritable || (writable.value.keys !== null && !writable.value.keys.includes(row.key))
const shown = (row: SettingRow) => (drafts.has(row.key) ? drafts.get(row.key) : row.value)
const modified = (row: SettingRow) => drafts.has(row.key)
function setDraft(row: SettingRow, value: unknown) {
  errors.delete(row.key)
  if (JSON.stringify(value) === JSON.stringify(row.value)) drafts.delete(row.key)
  else drafts.set(row.key, value)
}
/** An object or a list is edited as JSON text - kept as text until it parses. */
const jsonTexts = reactive(new Map<string, string>())
function jsonText(row: SettingRow): string {
  return jsonTexts.get(row.key) ?? JSON.stringify(shown(row), null, 2)
}
function setJson(row: SettingRow, text: string) {
  jsonTexts.set(row.key, text)
  try {
    setDraft(row, JSON.parse(text))
  } catch {
    errors.set(row.key, t('dataviews.settingsView.invalidJson'))
  }
}

/**
 * A text setting stored long or with lines - its saved value decides, so the control doesn't change while typing.
 * Longer than its narrow control shows on one line (T61: a 49-character footer legend was cut).
 */
const LONG_TEXT = 30
function isLongText(row: SettingRow): boolean {
  return typeof row.value === 'string' && (row.value.length > LONG_TEXT || row.value.includes('\n'))
}

/** Sections: by group, in the order of their first setting; settings by their order, else their title. */
const sections = computed(() => {
  const term = search.value.trim().toLowerCase()
  const matching = term ? rows.value.filter(r => r.title.toLowerCase().includes(term) || r.description.toLowerCase().includes(term)) : rows.value
  const sorted = [...matching].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title))
  const groups = new Map<string, SettingRow[]>()
  for (const row of sorted) {
    const list = groups.get(row.group) ?? []
    list.push(row)
    groups.set(row.group, list)
  }
  return [...groups.entries()].map(([group, settings]) => ({ group, settings, dirty: settings.some(modified) }))
})

/** Saves a section's changed settings, one PATCH each - each one PostgreSQL validates on its own. */
async function saveSection(group: string, settings: SettingRow[]) {
  savingGroup.value = group
  let saved = 0
  for (const row of settings.filter(modified)) {
    try {
      const value = drafts.get(row.key)
      await dataApi.patch(dataApi.resourcePath(props.schema, props.resourceName, 'table', row.pk), { data: { [col.value.valueColumn!]: value } })
      row.value = value
      drafts.delete(row.key)
      jsonTexts.delete(row.key)
      errors.delete(row.key)
      saved++
    } catch (error) {
      errors.set(row.key, errorMessage(error))
    }
  }
  savingGroup.value = null
  if (saved) toast.add({ title: t('dataviews.settingsView.saved', { n: saved }, saved), color: 'success' })
}
function discardSection(settings: SettingRow[]) {
  for (const row of settings) {
    drafts.delete(row.key)
    jsonTexts.delete(row.key)
    errors.delete(row.key)
  }
}

// Leaving the page with unsaved settings asks first.
useDiscardGuard(() => drafts.size > 0)
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-12">
    <UInput
      v-if="searchable && rows.length > 0"
      v-model="search"
      icon="i-lucide-search"
      :placeholder="t('dataviews.settingsView.search')"
      :aria-label="t('dataviews.settingsView.search')"
      class="w-full"
    />

    <UEmpty
      v-if="loading"
      loading
      variant="naked"
      size="sm"
    />
    <UAlert
      v-else-if="loadError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('dataviews.settingsView.loadError')"
      :description="loadError"
    />
    <UEmpty
      v-else-if="sections.length === 0"
      icon="i-lucide-sliders-horizontal"
      :title="search ? t('dataviews.settingsView.noMatch') : t('dataviews.settingsView.empty')"
    />

    <section
      v-for="section in sections"
      v-else
      :key="section.group"
      class="flex flex-col gap-4"
    >
      <h2
        v-if="section.group"
        class="border-b border-default pb-2 text-sm font-semibold uppercase tracking-wide text-highlighted"
      >
        {{ section.group }}
      </h2>

      <div class="flex flex-col divide-y divide-default">
        <div
          v-for="row in section.settings"
          :key="row.key"
          class="flex items-start justify-between gap-6 py-4 max-md:flex-col max-md:gap-2"
        >
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-sm font-medium text-highlighted">
              {{ row.title }}
              <UBadge
                v-if="modified(row)"
                :label="t('dataviews.settingsView.modified')"
                color="warning"
                variant="subtle"
                size="sm"
              />
              <UTooltip
                v-if="isLocked(row)"
                :text="t('dataviews.settingsView.locked')"
              >
                <UIcon
                  name="i-lucide-lock"
                  class="size-3.5 text-muted"
                  :aria-label="t('dataviews.settingsView.locked')"
                />
              </UTooltip>
            </p>
            <p
              v-if="row.description"
              class="mt-0.5 text-sm text-muted"
            >
              {{ row.description }}
            </p>
          </div>

          <div class="flex w-64 shrink-0 flex-col gap-1 max-md:w-full">
            <USwitch
              v-if="kindOf(row.value) === 'boolean'"
              :model-value="shown(row) === true"
              :disabled="isLocked(row)"
              :aria-label="row.title"
              @update:model-value="(v: boolean) => setDraft(row, v)"
            />
            <UInputNumber
              v-else-if="kindOf(row.value) === 'number'"
              :model-value="shown(row) as number"
              :disabled="isLocked(row)"
              :aria-label="row.title"
              class="w-full"
              @update:model-value="(v: number | null) => setDraft(row, v)"
            />
            <!-- The App's own date control, as every form's (T61). -->
            <WidgetInputDate
              v-else-if="kindOf(row.value) === 'date'"
              :model-value="shown(row) as string"
              column-type="date"
              :disabled="isLocked(row)"
              :aria-label="row.title"
              class="w-full"
              @update:model-value="(v: string | null | undefined) => setDraft(row, v ?? null)"
            />
            <UTextarea
              v-else-if="kindOf(row.value) === 'json'"
              :model-value="jsonText(row)"
              :disabled="isLocked(row)"
              :aria-label="row.title"
              :rows="3"
              class="w-full font-mono"
              @update:model-value="(v: string) => setJson(row, v)"
            />
            <!-- A long text or one with lines (a footer legend) gets its room; a short one, one line. -->
            <UTextarea
              v-else-if="isLongText(row)"
              :model-value="shown(row) == null ? '' : String(shown(row))"
              :disabled="isLocked(row)"
              :aria-label="row.title"
              autoresize
              :rows="2"
              class="w-full"
              @update:model-value="(v: string) => setDraft(row, v)"
            />
            <UInput
              v-else
              :model-value="shown(row) == null ? '' : String(shown(row))"
              :disabled="isLocked(row)"
              :aria-label="row.title"
              class="w-full"
              @update:model-value="(v: string) => setDraft(row, v)"
            />
            <p
              v-if="errors.get(row.key)"
              class="text-sm text-error"
            >
              {{ errors.get(row.key) }}
            </p>
          </div>
        </div>
      </div>

      <div
        v-if="section.dirty"
        class="flex justify-end gap-2"
      >
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="savingGroup === section.group"
          @click="discardSection(section.settings)"
        />
        <UButton
          :label="t('common.save')"
          icon="i-lucide-save"
          :loading="savingGroup === section.group"
          @click="saveSection(section.group, section.settings)"
        />
      </div>
    </section>
  </div>
</template>
