<script setup lang="ts">
import { invalidateDataViewCaps } from '~/composables/useDisplayFormatDefaults'
import type { Role } from '~/types/permission'
import { CUSTOM_CSS_EXAMPLES } from '~/utils/custom-css-examples'
/**
 * Generic settings-group editor: renders whatever GET /settings/{group}
 * currently returns, with the copy, widget and bounds of each key from
 * GET .../schema (@totalbase/settings' metadata.ts and registry.ts) - so
 * a new registry key shows up here without a UI change.
 *
 * Layout follows the Tailscale admin console pattern: no card, one
 * column, each setting a title + one-line description with its control.
 * Every change - a switch, a value, Restore default - is a pending edit
 * of the whole page, marked "Unsaved" on its field: one pinned footer
 * (Cancel, Save) commits them together, one PATCH per group (atomic per
 * group on the server), and leaving the page with edits asks first. A
 * value that differs from its registry default is marked "Modified";
 * Restore default puts the default in the draft, and saving it drops the
 * stored override (the server stores no value equal to its default).
 * A setting whose `dependsOn` switch is off is dimmed, still editable.
 */
const props = defineProps<{
  /**
   * One registry group, or several shown as one page (e.g. Transactions
   * + Idempotency) - each group still reads/writes through its own
   * GET/PATCH .../settings/{group}; a key without a `section` of its
   * own is listed under its group's label.
   */
  group: string | string[]
  /** Overrides the page header's title/description (the first group's copy by default). */
  title?: string
  description?: string
}>()

interface SettingField {
  key: string
  label: string
  description: string
  unit?: string
  section?: string
  input?: 'secret' | 'timezone' | 'json' | 'role' | 'image' | 'color' | 'css' | 'cards' | 'textarea'
  options?: Array<{ label: string, value: string, description?: string }>
  orientation?: 'vertical'
  dependsOn?: string
  links?: SettingLink[]
  default?: unknown
  min?: number
  max?: number
  /** Keys applied only at startup (pool.*): the value the server uses right now. */
  liveValue?: unknown
}
type SettingLink = { setting: string } | { page: 'secrets' | 'roles' | 'templates' | 'docs' }
interface SettingsSchema {
  group: { label: string, description: string }
  fields: SettingField[]
}

/** `saved`: the keys a save committed - a page that shows them elsewhere (Appearance's mark) re-reads. */
const emit = defineEmits<{ saved: [keys: string[]] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const ui = useUiLocale()

// --- The settings metadata catalog in the UI's language
// (Specification_Admin_UI.md §14): @totalbase/settings' metadata.ts is the
// English source the server sends; settings.metadata.* translates it, and a
// setting added later without a translation still reads in English. ---
const catalog = useCatalogText()
/** "Accounts & sessions" -> accountsSessions (as SettingsPanel.vue). */
function sectionKey(section: string) {
  return section.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('')
}
const metaKey = (key: string) => `settings.metadata.keys.${key.replaceAll('.', '__')}`
const groupText = (group: string, part: 'label' | 'description', english: string | undefined) => catalog(`settings.metadata.groups.${group}.${part}`, english)
const sectionText = (section: string) => catalog(`settings.metadata.sections.${sectionKey(section)}`, section)
const unitText = (unit: string) => catalog(`settings.metadata.units.${unit}`, unit)
const optionText = (field: SettingField, option: { label: string, value: string }) => catalog(`${metaKey(field.key)}.options.${option.value}`, option.label)
const optionDescription = (field: SettingField, option: { value: string, description?: string }) => option.description ? catalog(`${metaKey(field.key)}.optionDescriptions.${option.value}`, option.description) : undefined
/** `css`: Examples - each snippet appended to the sheet, to adjust from there. */
function cssExampleItems(key: string) {
  return CUSTOM_CSS_EXAMPLES.map(example => ({
    label: t(`settings.appearance.examples.${example.key}`),
    onSelect: () => {
      const current = String(draft.value[key] ?? '').trimEnd()
      draft.value[key] = `${current ? `${current}\n\n` : ''}${example.css}\n`
    }
  }))
}
/** `cards`: every option as a card with its description. */
const cardItems = (field: SettingField) => (field.options ?? []).map(option => ({ label: optionText(field, option), description: optionDescription(field, option), value: option.value }))
/** A field's label and description in the UI's language. */
const fieldLabel = (field: SettingField) => catalog(`${metaKey(field.key)}.label`, field.label)
const fieldDescription = (field: SettingField) => catalog(`${metaKey(field.key)}.description`, field.description)

const groups = computed(() => Array.isArray(props.group) ? props.group : [props.group])
const dataKey = groups.value.join('+')

const { data: settings, pending, error, refresh } = await useAsyncData(
  `settings-${dataKey}`,
  () => Promise.all(groups.value.map(g => api.get<Record<string, unknown>>(`/settings/${g}`).then(r => r.data)))
    .then(parts => Object.assign({}, ...parts) as Record<string, unknown>)
)
const { data: schemas } = await useAsyncData(
  `settings-${dataKey}-schema`,
  () => Promise.all(groups.value.map(g => api.get<SettingsSchema>(`/settings/${g}/schema`).then(r => r.data)))
)
// The page header reads the first group's copy unless `title` overrides it.
const schema = computed(() => schemas.value?.[0])

const draft = ref<Record<string, unknown>>({})
// Edits a save didn't commit (a later group failed): kept over the
// refreshed values instead of being dropped by the refresh.
const keptEdits = ref<Record<string, unknown>>({})
watch(settings, (s) => {
  if (s) draft.value = { ...structuredClone(toRaw(s)), ...structuredClone(toRaw(keptEdits.value)) }
}, { immediate: true })

// Field order/copy comes from the schema; a key the schema doesn't know
// about yet still renders under its bare name rather than being dropped.
const fields = computed<SettingField[]>(() => {
  const known = (schemas.value ?? []).flatMap(s => s.fields)
  const knownKeys = new Set(known.map(f => f.key))
  const fallback = Object.keys(draft.value)
    .filter(k => !knownKeys.has(k))
    .map(key => ({ key, label: shortKey(key), description: '' }))
  return [...known, ...fallback]
})
const fieldsByKey = computed(() => new Map(fields.value.map(f => [f.key, f])))

// Each key is listed under its own `section`, in order of first
// appearance. A key without one falls under its group's label when the
// page shows several groups, or in one unlabeled list otherwise.
const groupedFields = computed(() => {
  const groupLabel = (key: string) => {
    const group = groupOf(key)
    const english = schemas.value?.[groups.value.indexOf(group)]?.group.label
    return english === undefined ? group : groupText(group, 'label', english)
  }
  const sections = new Map<string | null, SettingField[]>()
  for (const field of fields.value) {
    const label = field.section ? sectionText(field.section) : (groups.value.length > 1 ? groupLabel(field.key) : null)
    if (!sections.has(label)) sections.set(label, [])
    sections.get(label)!.push(field)
  }
  return [...sections].map(([label, list]) => ({ label, fields: list }))
})

function groupOf(fullKey: string) {
  return groups.value.find(g => fullKey.startsWith(`${g}.`)) ?? groups.value[0]!
}
function shortKey(fullKey: string) {
  const group = groupOf(fullKey)
  return fullKey.startsWith(`${group}.`) ? fullKey.slice(group.length + 1) : fullKey
}

type Widget = 'boolean' | 'number' | 'array' | 'select' | 'secret' | 'timezone' | 'json' | 'role' | 'image' | 'color' | 'css' | 'cards' | 'textarea' | 'string'
function widgetFor(field: SettingField): Widget {
  if (field.input) return field.input
  if (field.options) return 'select'
  const value = settings.value?.[field.key]
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'array'
  return 'string'
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isDirty = (key: string) => !same(draft.value[key], settings.value?.[key])
const isModified = (field: SettingField) => field.default !== undefined && !same(settings.value?.[field.key], field.default)
// A startup-only setting saved since the server started (liveValue is
// what it runs with): a restart is pending.
function restartPending(field: SettingField) {
  return field.liveValue !== undefined && !isDirty(field.key) && !same(field.liveValue, settings.value?.[field.key])
}
function isDimmed(field: SettingField) {
  return !!field.dependsOn && settings.value?.[field.dependsOn] === false
}

// --- Human-readable hints next to raw numbers ---
function formatDuration(ms: number) {
  const steps: Array<[number, string]> = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'min'], [1000, 's']]
  for (const [size, label] of steps) {
    if (ms >= size) {
      const value = ms / size
      return `${Number.isInteger(value) ? value : value.toFixed(1)} ${label}`
    }
  }
  return `${ms} ms`
}
function numberHint(field: SettingField, value: unknown): string | null {
  if (typeof value !== 'number') return null
  if (field.unit === 'bytes' && value >= 1024) return formatBytes(value)
  if (field.unit === 'ms' && value >= 1000) return formatDuration(value)
  if (field.unit === 'seconds' && value >= 60) return formatDuration(value * 1000)
  return null
}
function formatValue(field: SettingField, value: unknown): string {
  if (typeof value === 'boolean') return value ? t('settings.groupForm.on') : t('settings.groupForm.off')
  if (Array.isArray(value)) return value.length ? value.join(', ') : t('settings.groupForm.none')
  if (value === '' || value === null || value === undefined) return t('settings.groupForm.empty')
  if (typeof value === 'number') {
    const hint = numberHint(field, value)
    return hint ?? (field.unit ? `${value.toLocaleString(ui.intlLocale.value)} ${unitText(field.unit)}` : value.toLocaleString(ui.intlLocale.value))
  }
  if (field.options) {
    const option = field.options.find(o => o.value === value)
    return option ? optionText(field, option) : String(value)
  }
  if (field.input === 'role') return roles.value.find(r => r.id === value)?.name ?? String(value)
  return String(value)
}

// --- Choices for select-like widgets. `''` can't be a select item's
// value, so an empty setting maps to NONE and back. ---
const NONE = '__none__'
const needsSecrets = computed(() => fields.value.some(f => f.input === 'secret'))
const { data: secretKeys } = await useAsyncData(
  `settings-${dataKey}-secret-keys`,
  () => needsSecrets.value
    ? api.get<Array<{ key: string }>>('/secrets').then(r => r.data.map(s => s.key))
    : Promise.resolve([] as string[]),
  { default: () => [] as string[] }
)
// `role`: the roles a user can be given by a setting - never a reserved
// one nor one with admin access (the server refuses those on save too).
const rolesApi = useRolesApi()
const needsRoles = computed(() => fields.value.some(f => f.input === 'role'))
const { data: roles } = await useAsyncData(
  `settings-${dataKey}-roles`,
  () => needsRoles.value ? rolesApi.list() : Promise.resolve([] as Role[]),
  { default: () => [] as Role[] }
)
const timezoneItems = computed(() => [
  { label: t('settings.groupForm.browserTimezone'), value: NONE },
  ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC']).map(z => ({ label: z, value: z }))
])
function selectItems(field: SettingField) {
  if (field.input === 'timezone') return timezoneItems.value
  if (field.input === 'secret') {
    const current = String(settings.value?.[field.key] ?? '')
    const keys = secretKeys.value.includes(current) || !current ? secretKeys.value : [current, ...secretKeys.value]
    return [{ label: t('common.none'), value: NONE }, ...keys.map(k => ({ label: k, value: k }))]
  }
  if (field.input === 'role') {
    const current = String(settings.value?.[field.key] ?? '')
    const allowed = roles.value.filter(r => !r.reserved && !r.adminAccess)
    const items = allowed.map(r => ({ label: r.name, description: r.description ?? undefined, value: r.id }))
    // A stored role no longer offered (deleted since) still shows what it is.
    if (current && !allowed.some(r => r.id === current)) items.unshift({ label: t('settings.groupForm.unknownRole', { id: current }), description: undefined, value: current })
    return [{ label: t('common.none'), value: NONE }, ...items]
  }
  return (field.options ?? []).map(option => ({ label: optionText(field, option), value: option.value }))
}
function selectValue(key: string) {
  return draft.value[key] === '' ? NONE : String(draft.value[key] ?? NONE)
}
function setSelectValue(key: string, value: string) {
  draft.value[key] = value === NONE ? '' : value
}

// --- Links under a description: where else to go to make a setting work -
// another setting (its page, scrolled to it) or an admin page. A secret or
// role input links Secrets or Roles by itself. ---
const LINK_PAGES = {
  secrets: { to: '/settings/secrets', label: 'shell.nav.items.secrets', icon: 'i-lucide-lock-keyhole' },
  roles: { to: '/roles', label: 'shell.nav.items.roles', icon: 'i-lucide-shield' },
  templates: { to: '/templates', label: 'shell.nav.items.templates', icon: 'i-lucide-file-text' },
  docs: { to: '/docs/openapi', label: 'settings.groupForm.docsOpenapi', icon: 'i-lucide-file-code' }
} as const
function fieldLinks(field: SettingField): { key: string, to: string, label: string, icon: string }[] {
  const links: SettingLink[] = [
    ...(field.input === 'secret' ? [{ page: 'secrets' as const }] : []),
    ...(field.input === 'role' ? [{ page: 'roles' as const }] : []),
    ...(field.links ?? [])
  ]
  return links.flatMap((link) => {
    if ('page' in link) {
      const page = LINK_PAGES[link.page]
      return [{ key: link.page, to: page.to, label: t(page.label), icon: page.icon }]
    }
    const route = SETTINGS_GROUP_ROUTES[link.setting.slice(0, link.setting.indexOf('.'))]
    if (!route) return []
    return [{ key: link.setting, to: `${route}#${settingAnchor(link.setting)}`, label: catalog(`${metaKey(link.setting)}.label`, link.setting), icon: 'i-lucide-settings' }]
  })
}

// --- Deep link: Settings search opens a page at #setting-<key> - scroll
// that setting into view once the fields exist, and outline it briefly.
const route = useRoute()
const highlightKey = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | undefined
async function revealHashedSetting() {
  const field = route.hash ? fields.value.find(f => `#${settingAnchor(f.key)}` === route.hash) : undefined
  if (!field) return
  await nextTick()
  document.getElementById(settingAnchor(field.key))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  highlightKey.value = field.key
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightKey.value = null
  }, 2000)
}
onMounted(revealHashedSetting)
watch(() => route.hash, revealHashedSetting)
onBeforeUnmount(() => clearTimeout(highlightTimer))

// --- Save / cancel / restore: one draft for the whole page ---
const session = useSession()
const DISPLAY_KEYS = new Set(['system.timezone', 'system.date_format', 'system.time_format', 'system.datetime_format', 'system.language'])
const saving = ref(false)
const fieldErrors = ref<Record<string, string>>({})
const dirtyKeys = computed(() => settings.value ? Object.keys(draft.value).filter(isDirty) : [])

function clearError(key: string) {
  if (key in fieldErrors.value) fieldErrors.value = Object.fromEntries(Object.entries(fieldErrors.value).filter(([k]) => k !== key))
}
// An edit clears its field's error - it's about the value that was refused.
watch(draft, () => {
  for (const key of Object.keys(fieldErrors.value)) if (!isDirty(key)) clearError(key)
}, { deep: true })

/** Commits every pending edit: one PATCH per group, stopping at the first group the server refuses. */
async function save() {
  if (saving.value || !dirtyKeys.value.length) return
  const keys = dirtyKeys.value
  const byGroup = new Map<string, string[]>()
  for (const key of keys) byGroup.set(groupOf(key), [...(byGroup.get(groupOf(key)) ?? []), key])
  saving.value = true
  fieldErrors.value = {}
  const saved: string[] = []
  try {
    for (const [group, groupKeys] of byGroup) {
      try {
        await api.patch(`/settings/${group}`, { data: Object.fromEntries(groupKeys.map(k => [shortKey(k), draft.value[k]])) })
        saved.push(...groupKeys)
      } catch (err) {
        // The server's own message ("sql_console.x: Expected a whole number
        // 1 or more.") goes under its field; the draft is kept to be fixed.
        const failed = err instanceof AdminApiError ? groupKeys.find(k => err.message.startsWith(`${k}: `)) : undefined
        if (failed) fieldErrors.value = { [failed]: (err as AdminApiError).message.slice(failed.length + 2) }
        else notifyError(err, t('settings.groupForm.saveError'))
        break
      }
    }
    if (!saved.length) return
    toast.add({ title: t('settings.groupForm.saved', saved.length), color: 'success' })
    keptEdits.value = Object.fromEntries(keys.filter(k => !saved.includes(k)).map(k => [k, draft.value[k]]))
    await refresh()
    keptEdits.value = {}
    // The instance's date/time defaults reach every screen through the
    // session's `display` (useDateTimeFormat) - re-read it so they apply now.
    if (saved.some(k => DISPLAY_KEYS.has(k))) await session.refreshProfile().catch(() => undefined)
    // Maps read the instance's tiles once (useMapTiles) - read them again.
    if (saved.some(k => k.startsWith('maps.'))) resetMapTiles()
    // DataViews read their row caps once (useDisplayFormatDefaults) - read them again.
    if (saved.some(k => k.startsWith('dataviews.'))) invalidateDataViewCaps()
    emit('saved', saved)
  } finally {
    saving.value = false
  }
}
function cancel() {
  if (settings.value) draft.value = structuredClone(toRaw(settings.value))
  fieldErrors.value = {}
}
function restoreDefault(field: SettingField) {
  draft.value[field.key] = structuredClone(toRaw(field.default))
}

useDiscardGuard(() => dirtyKeys.value.length > 0)
useRecordFormShortcuts(computed(() => dirtyKeys.value.length > 0), { onSave: save })
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="title ?? (schema ? groupText(groups[0]!, 'label', schema.group.label) : groups.join(' + '))"
        :description="description ?? (schema ? groupText(groups[0]!, 'description', schema.group.description) : undefined)"
      >
        <!-- Page-level actions, e.g. SMTP's "Send test email" - `dirty`
        while edits are pending (such an action uses the saved settings). -->
        <slot
          name="actions"
          :dirty="dirtyKeys.length > 0"
          :draft="draft"
        />
      </PageHeader>
    </template>
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error.message"
      />

      <!-- Above the fields: what the page shows besides them (MCP's connection details). -->
      <slot
        name="intro"
        :settings="settings"
      />

      <!-- Only the true first load (no data yet) shows the spinner in
      place of the form - every save's refresh() also flips `pending`, and
      swapping the field list for a spinner mid-page would reset the
      scroll position. -->
      <UEmpty
        v-if="pending && !settings"
        loading
        variant="naked"
        size="sm"
      />

      <template v-else>
        <template
          v-for="(section, sectionIndex) in groupedFields"
          :key="section.label ?? '_'"
        >
          <h3
            v-if="section.label"
            class="text-xs font-semibold uppercase tracking-wide text-muted"
            :class="sectionIndex > 0 ? 'mt-6' : undefined"
          >
            {{ section.label }}
          </h3>
          <template
            v-for="(field, index) in section.fields"
            :key="field.key"
          >
            <USeparator v-if="index > 0" />
            <div
              :id="settingAnchor(field.key)"
              class="flex flex-col gap-2 rounded-md outline-offset-8 transition-[opacity,outline-color] duration-500"
              :class="[
                isDimmed(field) ? 'opacity-60' : undefined,
                highlightKey === field.key ? 'outline-2 outline-primary/50' : 'outline-2 outline-transparent'
              ]"
            >
              <div class="flex items-start gap-4">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <h2 class="text-base font-semibold text-highlighted">
                      {{ fieldLabel(field) }}
                    </h2>
                    <UBadge
                      v-if="isModified(field)"
                      :label="t('settings.groupForm.modified')"
                      color="primary"
                      variant="subtle"
                      size="sm"
                    />
                    <UBadge
                      v-if="isDirty(field.key)"
                      :label="t('settings.groupForm.unsaved')"
                      color="warning"
                      variant="subtle"
                      size="sm"
                    />
                  </div>
                  <p
                    v-if="field.description"
                    class="text-sm text-muted"
                  >
                    {{ fieldDescription(field) }}
                  </p>
                  <p
                    v-if="fieldLinks(field).length > 0"
                    class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted"
                  >
                    <span>{{ t('settings.groupForm.seeAlso') }}</span>
                    <ULink
                      v-for="link in fieldLinks(field)"
                      :key="link.key"
                      :to="link.to"
                      class="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <UIcon
                        :name="link.icon"
                        class="size-3.5"
                      />
                      {{ link.label }}
                    </ULink>
                  </p>
                  <p
                    v-if="isDimmed(field)"
                    class="text-xs text-muted"
                  >
                    {{ t('settings.groupForm.noEffectWhileOff', { setting: fieldsByKey.get(field.dependsOn!) ? fieldLabel(fieldsByKey.get(field.dependsOn!)!) : field.dependsOn }) }}
                  </p>
                </div>
                <USwitch
                  v-if="widgetFor(field) === 'boolean'"
                  v-model="draft[field.key] as boolean"
                  :aria-label="fieldLabel(field)"
                  class="mt-1"
                />
              </div>

              <template v-if="widgetFor(field) !== 'boolean'">
                <SettingImageInput
                  v-if="widgetFor(field) === 'image'"
                  v-model="draft[field.key] as string"
                  :label="fieldLabel(field)"
                />
                <SettingColorInput
                  v-else-if="widgetFor(field) === 'color'"
                  v-model="draft[field.key] as string"
                  :label="fieldLabel(field)"
                />
                <URadioGroup
                  v-else-if="widgetFor(field) === 'cards'"
                  v-model="draft[field.key] as string"
                  :items="cardItems(field)"
                  variant="card"
                  :orientation="field.orientation ?? 'horizontal'"
                  :aria-label="fieldLabel(field)"
                  class="w-full"
                  :ui="{ fieldset: 'max-md:flex-col' }"
                />
                <div
                  v-else-if="widgetFor(field) === 'css'"
                  class="flex w-full flex-col gap-3"
                >
                  <CssThemePicker v-model="draft[field.key] as string" />
                  <div class="flex justify-end">
                    <UDropdownMenu :items="cssExampleItems(field.key)">
                      <UButton
                        :label="t('settings.appearance.examples.button')"
                        icon="i-lucide-sparkles"
                        trailing-icon="i-lucide-chevron-down"
                        color="neutral"
                        variant="outline"
                        size="sm"
                      />
                    </UDropdownMenu>
                  </div>
                  <CodeEditor
                    v-model="draft[field.key] as string"
                    language="css"
                    min-height="18rem"
                    class="w-full"
                  />
                </div>
                <div
                  v-else
                  class="flex flex-wrap items-center gap-2"
                >
                  <UInput
                    v-if="widgetFor(field) === 'number'"
                    v-model.number="draft[field.key] as number"
                    type="number"
                    :min="field.min"
                    :max="field.max"
                    :aria-label="fieldLabel(field)"
                    class="w-full max-w-xs"
                    @keydown.enter="save"
                  />
                  <UInputTags
                    v-else-if="widgetFor(field) === 'array'"
                    v-model="draft[field.key] as string[]"
                    :aria-label="fieldLabel(field)"
                    class="w-full max-w-md"
                  />
                  <USelectMenu
                    v-else-if="widgetFor(field) === 'timezone' || widgetFor(field) === 'secret' || widgetFor(field) === 'select' || widgetFor(field) === 'role'"
                    :model-value="selectValue(field.key)"
                    :items="selectItems(field)"
                    value-key="value"
                    :search-input="widgetFor(field) === 'timezone' || widgetFor(field) === 'role' ? {} : false"
                    :aria-label="fieldLabel(field)"
                    class="w-full max-w-md"
                    @update:model-value="(v: string) => setSelectValue(field.key, v)"
                  />
                  <UTextarea
                    v-else-if="widgetFor(field) === 'textarea'"
                    v-model="draft[field.key] as string"
                    :rows="6"
                    autoresize
                    :aria-label="fieldLabel(field)"
                    class="w-full"
                  />
                  <UTextarea
                    v-else-if="widgetFor(field) === 'json'"
                    v-model="draft[field.key] as string"
                    :rows="4"
                    autoresize
                    :aria-label="fieldLabel(field)"
                    class="w-full"
                    :ui="{ base: 'font-mono text-xs' }"
                  />
                  <UInput
                    v-else
                    v-model="draft[field.key] as string"
                    :aria-label="fieldLabel(field)"
                    class="w-full max-w-md"
                    @keydown.enter="save"
                  />
                  <span
                    v-if="field.unit"
                    class="text-sm text-muted shrink-0"
                  >{{ unitText(field.unit) }}<template v-if="numberHint(field, draft[field.key])"> · {{ numberHint(field, draft[field.key]) }}</template></span>
                </div>
                <p
                  v-if="widgetFor(field) === 'secret' && secretKeys.length === 0"
                  class="text-xs text-muted"
                >
                  <i18n-t
                    keypath="settings.groupForm.noSecrets"
                    scope="global"
                  >
                    <template #link>
                      <ULink
                        to="/settings/secrets"
                        class="underline"
                      >{{ t('settings.groupForm.secretsLink') }}</ULink>
                    </template>
                  </i18n-t>
                </p>
              </template>

              <p
                v-if="restartPending(field)"
                class="flex items-center gap-1.5 text-xs text-warning"
              >
                <UIcon
                  name="i-lucide-rotate-cw"
                  class="size-3.5 shrink-0"
                />
                {{ t('settings.groupForm.restartPending', { value: formatValue(field, field.liveValue) }) }}
              </p>
              <p
                v-if="fieldErrors[field.key]"
                class="text-sm text-error"
              >
                {{ fieldErrors[field.key] }}
              </p>
              <p
                v-if="isModified(field) && !same(draft[field.key], field.default)"
                class="flex flex-wrap items-center gap-1 text-xs text-muted"
              >
                <span v-if="widgetFor(field) !== 'json'">{{ t('settings.groupForm.defaultValue', { value: formatValue(field, field.default) }) }}</span>
                <UButton
                  :label="t('settings.groupForm.restoreDefault')"
                  color="neutral"
                  variant="link"
                  size="xs"
                  class="p-0"
                  @click="restoreDefault(field)"
                />
              </p>
            </div>
          </template>
        </template>
      </template>
    </div>
    <template
      v-if="dirtyKeys.length"
      #footer
    >
      <div class="relative">
        <span class="absolute left-0 top-1/2 -translate-y-1/2 text-sm text-muted max-md:hidden">
          {{ t('settings.groupForm.unsavedCount', dirtyKeys.length) }}
        </span>
        <RecordFormFooter
          :saving="saving"
          @cancel="cancel"
          @save="save"
        />
      </div>
    </template>
  </PageShell>
</template>
