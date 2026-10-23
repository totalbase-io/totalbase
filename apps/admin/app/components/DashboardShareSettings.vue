<script setup lang="ts">
/**
 * Settings › Share (Dashboards.md §9.5, D26): a dashboard's embeds - design one -
 * its look, what each variable is (Editable, Hidden, Locked), the sites
 * that may frame it, its expiry - with a live preview of exactly that, then
 * save it as a public link or a signed embed for a portal; copy, change,
 * revoke or delete the ones it has. The preview is the real embed page in a
 * frame, on a short-lived token the server signs for an administrator.
 */
import { DASHBOARD_REFRESH_INTERVALS } from '@totalbase/tb-catalog'
import { useDashboardCatalogText, type Dashboard, type DashboardVariable } from '~/types/dashboard'
import { useApiErrorMessage } from '~/utils/api-error-message'

type EmbedType = 'LINK' | 'SIGNED'
type Mode = 'EDITABLE' | 'HIDDEN' | 'LOCKED'
interface EmbedVariableConfig { mode: Mode, value?: unknown }
interface Embed {
  id: string
  name: string
  type: EmbedType
  display: { theme?: 'light' | 'dark' | 'auto', titled?: boolean, transparent?: boolean, refreshSeconds?: number | null, allowExport?: boolean, allowFiles?: boolean }
  variables: Record<string, EmbedVariableConfig>
  /** The one widget it shows - null, the whole dashboard. */
  widget: string | null
  origins: string[]
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  link: string | null
  /** Its page under the instance's public URL, built by the server (AGENTS.md §19A) - never the browser's origin. */
  url: string
}

const props = defineProps<{
  dashboard: Dashboard & { hasUnpublishedChanges?: boolean }
  /** Its section is the one shown - its embeds load, and its preview's token keeps fresh, only then. */
  active: boolean
}>()
const open = toRef(props, 'active')
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const appApi = useAppApi()
const toast = useToast()
const dates = useDateTimeFormat()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const catalog = useDashboardCatalogText()

// --- What the drawer needs: the embeds, the published variables, the instance's embedding settings. ---
const embeds = ref<Embed[]>([])
const published = ref<DashboardVariable[]>([])
/** The live version's widgets - which clicks an embed can't run (D6). */
const publishedWidgets = ref<{ id: string, type: string, label: string | null, config: Record<string, unknown> }[]>([])
const allowedOrigins = ref<string[]>([])
const secretConfigured = ref(false)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const [list, variables, settings, widgets] = await Promise.all([
      api.get<Embed[]>(`/dashboards/${props.dashboard.id}/embeds`).then(r => r.data),
      appApi.get<DashboardVariable[]>(`/dashboards/${props.dashboard.id}/variables`).then(r => r.data).catch(() => [] as DashboardVariable[]),
      api.get<Record<string, unknown>>('/settings/dashboards').then(r => r.data),
      appApi.get<typeof publishedWidgets.value>(`/dashboards/${props.dashboard.id}/widgets`).then(r => r.data).catch(() => [])
    ])
    embeds.value = list
    published.value = variables
    publishedWidgets.value = widgets
    allowedOrigins.value = (settings['dashboards.embed_allowed_origins'] as string[] | undefined) ?? []
    secretConfigured.value = Boolean(settings['dashboards.embed_secret_key'])
  } catch (err) {
    notifyError(err, t('dashboards.embedDrawer.loadFailed'))
  } finally {
    loading.value = false
  }
}
watch(open, (isOpen) => {
  if (isOpen) {
    resetForm()
    void load()
  }
})

// --- Allow embedding (the dashboard's switch) ---
const togglingEmbedding = ref(false)
async function setEmbedding(enabled: boolean) {
  togglingEmbedding.value = true
  try {
    await api.patch(`/dashboards/${props.dashboard.id}`, { data: { embeddingEnabled: enabled } })
    emit('saved')
  } catch (err) {
    notifyError(err, t('dashboards.embedDrawer.toggleFailed'))
  } finally {
    togglingEmbedding.value = false
  }
}

// --- The embed being designed ---
const THEMES = computed(() => [{ label: t('dashboards.embedDrawer.themes.auto'), value: 'auto' }, { label: t('dashboards.embedDrawer.themes.light'), value: 'light' }, { label: t('dashboards.embedDrawer.themes.dark'), value: 'dark' }])
const REFRESH = computed(() => [
  { label: t('dashboards.embedDrawer.refreshAsDashboard'), value: -1 },
  { label: t('dashboards.detailsModal.refreshOff'), value: 0 },
  ...DASHBOARD_REFRESH_INTERVALS.map(i => ({ label: catalog.refreshLabel(i.seconds, i.label), value: i.seconds }))
])
const EXPIRY = computed(() => [
  { label: t('dashboards.embedDrawer.expiry.never'), value: 0 },
  { label: t('dashboards.embedDrawer.expiry.days30'), value: 30 },
  { label: t('dashboards.embedDrawer.expiry.days90'), value: 90 },
  { label: t('dashboards.embedDrawer.expiry.year'), value: 365 }
])
const MODES = computed(() => [
  { label: t('dashboards.embedDrawer.modes.editable'), value: 'EDITABLE', description: t('dashboards.embedDrawer.modes.editableHelp') },
  { label: t('dashboards.embedDrawer.modes.hidden'), value: 'HIDDEN', description: t('dashboards.embedDrawer.modes.hiddenHelp') },
  { label: t('dashboards.embedDrawer.modes.locked'), value: 'LOCKED', description: t('dashboards.embedDrawer.modes.lockedHelp') }
])
const KINDS = computed(() => [
  { label: t('dashboards.embedDrawer.kinds.link'), value: 'LINK', description: t('dashboards.embedDrawer.kinds.linkHelp') },
  { label: t('dashboards.embedDrawer.kinds.signed'), value: 'SIGNED', description: t('dashboards.embedDrawer.kinds.signedHelp') }
])

/** "The whole dashboard" in the Shows select - a select item can't hold null. */
const WHOLE = 'WHOLE'
const SHOWS = computed(() => [
  { label: t('dashboards.embedDrawer.wholeDashboard'), value: WHOLE },
  ...publishedWidgets.value.map(w => ({ label: widgetName(w), value: w.id }))
])
function widgetName(widget: { type: string, label: string | null }): string {
  return widget.label || catalog.widgetLabel(widget.type as never)
}

const editingId = ref<string | null>(null)
const form = reactive({
  name: '',
  type: 'LINK' as EmbedType,
  widget: WHOLE as string,
  theme: 'auto' as 'auto' | 'light' | 'dark',
  titled: false,
  transparent: false,
  allowExport: false,
  allowFiles: false,
  refresh: -1,
  expiryDays: 0,
  keepExpiry: null as string | null,
  origins: [] as string[],
  variables: {} as Record<string, { mode: Mode, text: string }>
})

/** A variable's value as the inputs below write it - the App's URL form: `from..to`, a preset, comma-separated for a multiple SELECT. */
function toText(variable: DashboardVariable | undefined, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') {
    const range = value as { from?: string, to?: string }
    return `${range.from ?? ''}..${range.to ?? ''}`
  }
  return String(value)
}
function fromText(variable: DashboardVariable, text: string): unknown {
  const value = text.trim()
  if (!value) return undefined
  if (variable.type === 'NUMBER') return Number.isFinite(Number(value)) ? Number(value) : value
  if (variable.type === 'DATE_RANGE') {
    const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value)
    return range ? { from: range[1], to: range[2] } : value
  }
  if (variable.type === 'SELECT' && variable.multiple) return value.split(',').map(v => v.trim()).filter(Boolean)
  return value
}

function resetForm(embed?: Embed) {
  editingId.value = embed?.id ?? null
  form.name = embed?.name ?? ''
  form.type = embed?.type ?? 'LINK'
  form.widget = embed?.widget ?? WHOLE
  form.theme = embed?.display.theme ?? 'auto'
  form.titled = embed?.display.titled ?? false
  form.transparent = embed?.display.transparent ?? false
  form.allowExport = embed?.display.allowExport ?? false
  form.allowFiles = embed?.display.allowFiles ?? false
  form.refresh = embed?.display.refreshSeconds === undefined ? -1 : (embed.display.refreshSeconds ?? 0)
  form.expiryDays = 0
  form.keepExpiry = embed?.expiresAt ?? null
  form.origins = [...(embed?.origins ?? [])]
  form.variables = Object.fromEntries(published.value.map((v) => {
    const config = embed?.variables[v.name]
    return [v.name, { mode: config?.mode ?? 'EDITABLE', text: toText(v, config?.value) }]
  }))
}
const widgetId = computed(() => (form.widget === WHOLE ? null : form.widget))
// One widget shows its title unless the author turns it off - picked for a new embed, the title comes on.
watch(() => form.widget, (value, previous) => {
  if (!editingId.value && value !== WHOLE && previous === WHOLE) form.titled = true
})
// The variables arrive after the form opens: give each one its row.
watch(published, (list) => {
  for (const v of list) form.variables[v.name] ??= { mode: 'EDITABLE', text: '' }
})

function variablesPayload(forPreview: boolean): Record<string, EmbedVariableConfig> {
  const out: Record<string, EmbedVariableConfig> = {}
  for (const variable of published.value) {
    const row = form.variables[variable.name]
    if (!row) continue
    const value = fromText(variable, row.text)
    // A signed embed's locked value left empty comes from the token; the preview shows it locked to nothing.
    if (row.mode === 'EDITABLE' && value === undefined) continue
    out[variable.name] = value === undefined || (!forPreview && row.mode === 'LOCKED' && form.type === 'SIGNED' && !row.text.trim())
      ? { mode: row.mode }
      : { mode: row.mode, value }
  }
  return out
}
const display = computed(() => ({
  theme: form.theme,
  titled: form.titled,
  transparent: form.transparent,
  ...(form.allowExport && { allowExport: true }),
  ...(form.allowFiles && { allowFiles: true }),
  ...(form.refresh === -1 ? {} : { refreshSeconds: form.refresh === 0 ? null : form.refresh })
}))
/**
 * The widgets whose click doesn't run in this embed (D6): an embed runs a FILTER on a variable its visitor may change
 * and a URL marked "also in embeds" - nothing that opens the App.
 */
const clicksNotHere = computed(() => publishedWidgets.value.filter(widget => !widgetId.value || widget.id === widgetId.value).filter((widget) => {
  const click = widget.config.click as { action?: string, variable?: string, inEmbeds?: boolean } | undefined
  if (!click) return false
  // One widget alone has no bar and nothing a filter would reach: only its URL clicks run.
  if (click.action === 'FILTER') return Boolean(widgetId.value) || form.variables[click.variable ?? '']?.mode !== 'EDITABLE'
  if (click.action === 'URL') return click.inEmbeds !== true
  return true
}).map(widget => widget.label || catalog.widgetLabel(widget.type as never)))
const lockedMissingValue = computed(() => form.type === 'LINK'
  ? published.value.filter(v => form.variables[v.name]?.mode === 'LOCKED' && !form.variables[v.name]?.text.trim()).map(v => v.label || v.name)
  : [])
const canSave = computed(() => form.name.trim().length > 0 && form.name.trim().length <= 32 && lockedMissingValue.value.length === 0)

// --- Live preview: the real embed page, on a token the server signs for this design. ---
type Device = 'desktop' | 'tablet' | 'phone'
const DEVICES = computed(() => [
  { label: t('dashboards.embedDrawer.devices.desktop'), value: 'desktop', icon: 'i-lucide-monitor' },
  { label: t('dashboards.embedDrawer.devices.tablet'), value: 'tablet', icon: 'i-lucide-tablet' },
  { label: t('dashboards.embedDrawer.devices.phone'), value: 'phone', icon: 'i-lucide-smartphone' }
])
const DEVICE_WIDTH: Record<Device, string> = { desktop: '100%', tablet: '768px', phone: '390px' }
const device = ref<Device>('desktop')
const previewToken = ref<string | null>(null)
const previewError = ref<string | null>(null)
let previewTimer: ReturnType<typeof setTimeout> | undefined
async function refreshPreview() {
  if (published.value.length === 0 && !(await hasPublishedVersion())) return
  try {
    const { data } = await api.post<{ token: string }>(`/dashboards/${props.dashboard.id}/embeds/preview`, {
      data: { display: display.value, variables: variablesPayload(true), widget: widgetId.value }
    })
    previewToken.value = data.token
    previewError.value = null
  } catch (err) {
    previewError.value = errorMessage(err, t('dashboards.embedDrawer.previewFailed'))
  }
}
const publishedOnce = ref<boolean | null>(null)
async function hasPublishedVersion(): Promise<boolean> {
  if (publishedOnce.value === null) {
    publishedOnce.value = await api.get<unknown[]>(`/dashboards/${props.dashboard.id}/versions`).then(r => r.data.length > 0).catch(() => false)
  }
  return publishedOnce.value
}
watch([open, display, widgetId, () => JSON.stringify(variablesPayload(true))], ([isOpen]) => {
  if (!isOpen) return
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void refreshPreview(), 400)
})
// A token lives 10 minutes - a fresh one before then while the drawer stays open.
const renewer = setInterval(() => {
  if (open.value) void refreshPreview()
}, 8 * 60 * 1000)
onBeforeUnmount(() => {
  clearTimeout(previewTimer)
  clearInterval(renewer)
})
const previewSrc = computed(() => (previewToken.value ? `/embed/preview#${previewToken.value}` : ''))

// Each change mounts a new frame, blank until the embedded app boots: a
// spinner covers it until the embed says it rendered (its first resize
// message, pages/embed/[key].vue) - or shortly after the frame's `load`,
// should that message never come.
const previewFrame = ref<HTMLIFrameElement | null>(null)
const previewLoading = ref(true)
let loadFallback: ReturnType<typeof setTimeout> | undefined
watch(previewSrc, () => {
  previewLoading.value = true
  clearTimeout(loadFallback)
})
function onPreviewMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.data?.type !== 'totalbase:embed:resize') return
  if (previewFrame.value && event.source === previewFrame.value.contentWindow) previewLoading.value = false
}
function onPreviewLoad() {
  clearTimeout(loadFallback)
  loadFallback = setTimeout(() => {
    previewLoading.value = false
  }, 1500)
}
onMounted(() => window.addEventListener('message', onPreviewMessage))
onBeforeUnmount(() => {
  window.removeEventListener('message', onPreviewMessage)
  clearTimeout(loadFallback)
})

// --- Save ---
const saving = ref(false)
const optionsColumn = ref<HTMLElement | null>(null)
async function save() {
  saving.value = true
  const expiresAt = form.expiryDays > 0 ? new Date(Date.now() + form.expiryDays * 24 * 60 * 60 * 1000).toISOString() : (editingId.value ? form.keepExpiry : null)
  const body = {
    name: form.name.trim(),
    display: display.value,
    variables: variablesPayload(false),
    widget: widgetId.value,
    origins: form.origins,
    expiresAt
  }
  try {
    if (editingId.value) {
      await api.patch(`/dashboards/${props.dashboard.id}/embeds/${editingId.value}`, { data: body })
      toast.add({ title: t('dashboards.embedDrawer.saved'), color: 'success' })
    } else {
      const { data } = await api.post<Embed>(`/dashboards/${props.dashboard.id}/embeds`, { data: { ...body, type: form.type } })
      toast.add({ title: data.type === 'LINK' ? t('dashboards.embedDrawer.linkCreated') : t('dashboards.embedDrawer.signedCreated'), color: 'success' })
      editingId.value = data.id
      // Its URL box is at the top of the form - bring it into view (the Create button is at the bottom).
      await nextTick()
      optionsColumn.value?.scrollTo({ top: 0, behavior: 'smooth' })
    }
    embeds.value = (await api.get<Embed[]>(`/dashboards/${props.dashboard.id}/embeds`)).data
  } catch (err) {
    notifyError(err, t('dashboards.embedDrawer.saveFailed'))
  } finally {
    saving.value = false
  }
}

// --- The embeds it has ---
function embedUrl(embed: Embed): string {
  return embed.type === 'LINK' ? embed.url : `${embed.url}#<TOKEN>`
}
/** The origin the embed's page posts its height from: the public URL's. */
function embedOrigin(embed: Embed): string {
  try {
    return new URL(embed.url).origin
  } catch {
    return window.location.origin
  }
}
function signedPayload(embed: Embed): string {
  const params = Object.fromEntries(Object.entries(embed.variables).filter(([, c]) => c.mode === 'LOCKED' && c.value === undefined).map(([name]) => [name, '<value for this visitor>']))
  return JSON.stringify({ resource: { embed: embed.id }, params, exp: '<now + a few minutes, in seconds>' }, null, 2)
}
const missingLocked = (embed: Embed) => Object.entries(embed.variables)
  .filter(([name, c]) => c.mode === 'LOCKED' && published.value.length > 0 && !published.value.some(v => v.name === name))
  .map(([name]) => name)
/** Its one widget, as the live version names it - undefined when that version no longer has it. */
const shownWidget = (embed: Embed) => (embed.widget ? publishedWidgets.value.find(w => w.id === embed.widget) : undefined)
const widgetGone = (embed: Embed) => Boolean(embed.widget) && publishedWidgets.value.length > 0 && !shownWidget(embed)
function status(embed: Embed): { label: string, color: 'success' | 'neutral' | 'warning' | 'error' } {
  if (embed.revokedAt) return { label: t('dashboards.embedDrawer.status.revoked'), color: 'neutral' }
  if (embed.expiresAt && new Date(embed.expiresAt) <= new Date()) return { label: t('dashboards.embedDrawer.status.expired'), color: 'neutral' }
  if (missingLocked(embed).length > 0 || widgetGone(embed)) return { label: t('dashboards.embedDrawer.status.needsUpdate'), color: 'error' }
  return { label: t('common.active'), color: 'success' }
}
/** `copied`: the toast once it's on the clipboard ("Link copied"). */
async function copy(text: string, copied: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: copied, color: 'success' })
  } catch {
    toast.add({ title: t('dashboards.embedDrawer.copyFailed'), color: 'error' })
  }
}
/** A literal closing script tag would end this component's own <script> block. */
const SCRIPT_CLOSE = '<' + '/script>'
function iframeSnippet(embed: Embed): string {
  // One widget fills the frame the site sizes - no resize to listen to.
  if (embed.widget) return `<iframe src="${embedUrl(embed)}" style="width:100%;height:240px;border:0" title="${props.dashboard.name}"></iframe>`
  return `<iframe src="${embedUrl(embed)}" style="width:100%;border:0" title="${props.dashboard.name}"></iframe>
<script>
  // Sizes the frame to the dashboard (totalbase:embed:resize).
  addEventListener('message', (e) => {
    if (e.origin === '${embedOrigin(embed)}' && e.data?.type === 'totalbase:embed:resize') document.querySelector('iframe[title="${props.dashboard.name}"]').style.height = e.data.height + 'px'
  })
${SCRIPT_CLOSE}`
}
async function revoke(embed: Embed) {
  try {
    await api.post(`/dashboards/${props.dashboard.id}/embeds/${embed.id}/revoke`)
    embeds.value = (await api.get<Embed[]>(`/dashboards/${props.dashboard.id}/embeds`)).data
    toast.add({ title: t('dashboards.embedDrawer.revoked', { name: embed.name }), color: 'success' })
  } catch (err) {
    notifyError(err, t('dashboards.embedDrawer.revokeFailed'))
  }
}
async function remove(embed: Embed) {
  try {
    await api.del(`/dashboards/${props.dashboard.id}/embeds/${embed.id}`)
    if (editingId.value === embed.id) resetForm()
    embeds.value = embeds.value.filter(e => e.id !== embed.id)
  } catch (err) {
    notifyError(err, t('dashboards.embedDrawer.deleteFailed'))
  }
}
const editing = computed(() => embeds.value.find(e => e.id === editingId.value) ?? null)
// Mounted on its section's first visit: load at once - after every declaration above.
onMounted(() => {
  if (!open.value) return
  resetForm()
  void load()
  previewTimer = setTimeout(() => void refreshPreview(), 400)
})
</script>

<template>
  <SettingsSection
    class="min-h-0 flex-1"
    :title="t('dashboards.settings.sections.share')"
    :description="t('dashboards.embedDrawer.description')"
  >
    <template #actions>
      <UTabs
        v-model="device"
        :items="DEVICES"
        :content="false"
        size="xs"
        :aria-label="t('dashboards.embedDrawer.device')"
        class="shrink-0 max-md:hidden"
      />
    </template>
    <UAlert
      color="info"
      variant="subtle"
      icon="i-lucide-zap"
      :title="t('dashboards.settings.appliesAtOnce')"
    />

    <div class="flex min-h-0 flex-1 gap-4 max-md:flex-col">
      <!-- Options and embeds -->
      <div
        ref="optionsColumn"
        class="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto pr-1 max-md:w-full [&>*]:shrink-0"
      >
        <USwitch
          :model-value="dashboard.embeddingEnabled === true"
          :loading="togglingEmbedding"
          :label="t('dashboards.embedDrawer.allowEmbedding')"
          :description="t('dashboards.embedDrawer.allowEmbeddingHelp')"
          @update:model-value="(v: boolean) => setEmbedding(v)"
        />
        <UAlert
          v-if="dashboard.hasUnpublishedChanges"
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          :title="t('dashboards.embedDrawer.unpublishedTitle')"
          :description="t('dashboards.embedDrawer.unpublishedHelp')"
        />
        <UAlert
          v-if="!loading && allowedOrigins.length === 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('dashboards.embedDrawer.noOriginsTitle')"
          :description="t('dashboards.embedDrawer.noOriginsHelp')"
        />

        <div class="flex flex-col gap-3 rounded-lg border border-default p-3">
          <div class="flex items-center justify-between">
            <p class="text-sm font-semibold text-highlighted">
              {{ editing ? t('dashboards.embedDrawer.editTitle', { name: editing.name }) : t('dashboards.embedDrawer.newEmbed') }}
            </p>
            <UButton
              v-if="editingId"
              :label="t('dashboards.embedDrawer.newEmbed')"
              icon="i-lucide-plus"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="resetForm()"
            />
          </div>
          <!-- The saved embed's address, right where it was just created - what goes in the other site. -->
          <div
            v-if="editing && !editing.revokedAt"
            class="flex flex-col gap-2 rounded-md bg-elevated p-2"
          >
            <p class="text-xs font-medium text-highlighted">
              {{ editing.type === 'LINK' ? t('dashboards.embedDrawer.linkToPaste') : t('dashboards.embedDrawer.urlToFrame') }}
            </p>
            <code class="break-all text-xs">{{ embedUrl(editing) }}</code>
            <div class="flex flex-wrap gap-1">
              <UButton
                :label="editing.type === 'LINK' ? t('dashboards.embedDrawer.copyLink') : t('dashboards.embedDrawer.copyUrl')"
                icon="i-lucide-copy"
                size="xs"
                @click="copy(embedUrl(editing), editing.type === 'LINK' ? t('dashboards.embedDrawer.copied.link') : t('dashboards.embedDrawer.copied.url'))"
              />
              <UButton
                :label="t('dashboards.embedDrawer.copyIframe')"
                icon="i-lucide-code-xml"
                size="xs"
                color="neutral"
                variant="outline"
                @click="copy(iframeSnippet(editing), t('dashboards.embedDrawer.copied.iframe'))"
              />
              <UButton
                v-if="editing.type === 'SIGNED'"
                :label="t('dashboards.embedDrawer.copyPayload')"
                icon="i-lucide-braces"
                size="xs"
                color="neutral"
                variant="outline"
                @click="copy(signedPayload(editing), t('dashboards.embedDrawer.copied.payload'))"
              />
            </div>
          </div>
          <UFormField
            :label="t('common.name')"
            :description="t('dashboards.embedDrawer.nameHelp')"
          >
            <UInput
              v-model="form.name"
              :maxlength="32"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="!editingId"
            :label="t('dashboards.embedDrawer.kind')"
          >
            <URadioGroup
              v-model="form.type"
              :items="KINDS"
            />
          </UFormField>
          <UFormField
            :label="t('dashboards.embedDrawer.shows')"
            :description="t('dashboards.embedDrawer.showsHelp')"
          >
            <USelect
              v-model="form.widget"
              :items="SHOWS"
              class="w-full"
              :aria-label="t('dashboards.embedDrawer.shows')"
            />
          </UFormField>
          <div class="flex gap-3">
            <UFormField
              :label="t('dashboards.embedDrawer.theme')"
              class="flex-1"
            >
              <USelect
                v-model="form.theme"
                :items="THEMES"
                class="w-full"
                :aria-label="t('dashboards.embedDrawer.theme')"
              />
            </UFormField>
            <UFormField
              :label="t('common.refresh')"
              class="flex-1"
            >
              <USelect
                v-model="form.refresh"
                :items="REFRESH"
                class="w-full"
                :aria-label="t('common.refresh')"
              />
            </UFormField>
          </div>
          <div class="flex flex-col gap-2">
            <UCheckbox
              v-model="form.titled"
              :label="widgetId ? t('dashboards.embedDrawer.showWidgetTitle') : t('dashboards.embedDrawer.showTitle')"
            />
            <UCheckbox
              v-model="form.transparent"
              :label="t('dashboards.embedDrawer.transparent')"
            />
            <UCheckbox
              v-model="form.allowExport"
              :label="t('dashboards.embedDrawer.allowExport')"
              :description="t('dashboards.embedDrawer.allowExportHelp')"
            />
            <UCheckbox
              v-model="form.allowFiles"
              :label="t('dashboards.embedDrawer.allowFiles')"
              :description="t('dashboards.embedDrawer.allowFilesHelp')"
            />
            <UAlert
              v-if="form.allowFiles"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="form.type === 'LINK' ? t('dashboards.embedDrawer.allowFilesLinkWarning') : t('dashboards.embedDrawer.allowFilesWarning')"
            />
          </div>
          <p
            v-if="clicksNotHere.length"
            class="text-xs text-muted"
          >
            {{ t('dashboards.embedDrawer.clicksNotHere', { widgets: clicksNotHere.join(', ') }) }}
          </p>

          <div
            v-if="published.length"
            class="flex flex-col gap-2"
          >
            <p class="text-sm font-medium">
              {{ t('dashboards.variablesModal.title') }}
            </p>
            <div
              v-for="variable in published"
              :key="variable.name"
              class="flex flex-col gap-1"
            >
              <div
                v-if="form.variables[variable.name]"
                class="flex items-center gap-2"
              >
                <span class="w-24 truncate text-sm">{{ variable.label || variable.name }}</span>
                <USelect
                  v-model="form.variables[variable.name]!.mode"
                  :items="MODES"
                  class="w-28"
                  :aria-label="t('dashboards.embedDrawer.variableMode', { label: variable.label || variable.name })"
                />
                <UInput
                  v-model="form.variables[variable.name]!.text"
                  class="min-w-0 flex-1"
                  :aria-label="t('dashboards.embedDrawer.variableValue', { label: variable.label || variable.name })"
                />
              </div>
            </div>
            <p class="text-xs text-muted">
              {{ t(form.type === 'SIGNED' ? 'dashboards.embedDrawer.variablesHelpSigned' : 'dashboards.embedDrawer.variablesHelp', { example: '2026-01-01..2026-03-31' }) }}
            </p>
            <p
              v-if="lockedMissingValue.length"
              class="text-xs text-error"
            >
              {{ t('dashboards.embedDrawer.lockedMissing', { names: lockedMissingValue.join(', ') }) }}
            </p>
          </div>
          <p
            v-else-if="!loading"
            class="text-xs text-muted"
          >
            {{ t('dashboards.embedDrawer.noVariables') }}
          </p>

          <UFormField
            :label="t('dashboards.embedDrawer.origins')"
            :description="t('dashboards.embedDrawer.originsHelp')"
          >
            <USelectMenu
              v-model="form.origins"
              :items="allowedOrigins"
              multiple
              class="w-full"
              :aria-label="t('dashboards.embedDrawer.origins')"
            />
          </UFormField>
          <UFormField
            :label="t('dashboards.embedDrawer.expires')"
            :description="editingId && form.keepExpiry ? t('dashboards.embedDrawer.expiresNow', { date: dates.dateTime(form.keepExpiry) }) : undefined"
          >
            <USelect
              v-model="form.expiryDays"
              :items="EXPIRY"
              class="w-full"
              :aria-label="t('dashboards.embedDrawer.expires')"
            />
          </UFormField>
          <UAlert
            v-if="form.type === 'LINK'"
            color="neutral"
            variant="subtle"
            icon="i-lucide-globe"
            :description="t('dashboards.embedDrawer.linkPublicHelp')"
          />
          <UAlert
            v-else-if="!secretConfigured"
            color="warning"
            variant="subtle"
            icon="i-lucide-key-round"
            :description="t('dashboards.embedDrawer.secretMissing')"
          />
          <div class="flex justify-end">
            <UButton
              :label="editingId ? t('common.saveChanges') : (form.type === 'LINK' ? t('dashboards.embedDrawer.createLink') : t('dashboards.embedDrawer.createSigned'))"
              :loading="saving"
              :disabled="!canSave"
              @click="save"
            />
          </div>
        </div>

        <!-- Its embeds -->
        <div class="flex flex-col gap-2">
          <p class="text-sm font-semibold text-highlighted">
            {{ t('dashboards.embedDrawer.embeds') }}
          </p>
          <UEmpty
            v-if="!loading && embeds.length === 0"
            icon="i-lucide-code-xml"
            :title="t('dashboards.embedDrawer.empty')"
            variant="naked"
            size="sm"
          />
          <div
            v-for="embed in embeds"
            :key="embed.id"
            class="flex flex-col gap-2 rounded-lg border border-default p-3"
            :class="editingId === embed.id ? 'border-primary' : ''"
          >
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ embed.name }}</span>
              <UBadge
                :label="embed.type === 'LINK' ? t('dashboards.embedDrawer.badges.link') : t('dashboards.embedDrawer.badges.signed')"
                color="neutral"
                variant="subtle"
              />
              <UBadge
                :label="status(embed).label"
                :color="status(embed).color"
                variant="subtle"
              />
            </div>
            <p
              v-if="shownWidget(embed)"
              class="text-xs text-muted"
            >
              {{ t('dashboards.embedDrawer.showsWidget', { widget: widgetName(shownWidget(embed)!) }) }}
            </p>
            <p
              v-if="widgetGone(embed)"
              class="text-xs text-error"
            >
              {{ t('dashboards.embedDrawer.widgetMissing') }}
            </p>
            <p class="text-xs text-muted">
              {{ embed.lastUsedAt ? t('dashboards.embedDrawer.lastUsed', { date: dates.dateTime(embed.lastUsedAt) }) : t('dashboards.embedDrawer.notUsed') }}{{ embed.expiresAt ? t('dashboards.embedDrawer.expiresOn', { date: dates.dateTime(embed.expiresAt) }) : '' }}
            </p>
            <p
              v-if="missingLocked(embed).length"
              class="text-xs text-error"
            >
              {{ t('dashboards.embedDrawer.locksMissing', { names: missingLocked(embed).join(', ') }) }}
            </p>
            <code
              v-if="!embed.revokedAt"
              class="break-all rounded bg-elevated px-2 py-1 text-xs"
            >{{ embedUrl(embed) }}</code>
            <div
              v-if="!embed.revokedAt"
              class="flex flex-wrap gap-1"
            >
              <UButton
                :label="embed.type === 'LINK' ? t('dashboards.embedDrawer.copyLink') : t('dashboards.embedDrawer.copyUrl')"
                icon="i-lucide-copy"
                size="xs"
                color="neutral"
                variant="outline"
                @click="copy(embedUrl(embed), embed.type === 'LINK' ? t('dashboards.embedDrawer.copied.link') : t('dashboards.embedDrawer.copied.url'))"
              />
              <UButton
                v-if="embed.type === 'SIGNED'"
                :label="t('dashboards.embedDrawer.copyPayload')"
                icon="i-lucide-braces"
                size="xs"
                color="neutral"
                variant="outline"
                @click="copy(signedPayload(embed), t('dashboards.embedDrawer.copied.payload'))"
              />
              <UButton
                :label="t('dashboards.embedDrawer.copyIframe')"
                icon="i-lucide-code-xml"
                size="xs"
                color="neutral"
                variant="outline"
                @click="copy(iframeSnippet(embed), t('dashboards.embedDrawer.copied.iframe'))"
              />
              <UButton
                :label="t('common.edit')"
                icon="i-lucide-pencil"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="resetForm(embed)"
              />
              <UPopover>
                <UButton
                  :label="t('dashboards.embedDrawer.revoke')"
                  icon="i-lucide-ban"
                  size="xs"
                  color="error"
                  variant="ghost"
                />
                <template #content="{ close }">
                  <div class="flex max-w-64 flex-col gap-2 p-3">
                    <p class="text-sm">
                      {{ t('dashboards.embedDrawer.revokeConfirm', { name: embed.name }) }}
                    </p>
                    <div class="flex justify-end">
                      <UButton
                        :label="t('dashboards.embedDrawer.revoke')"
                        size="xs"
                        color="error"
                        @click="close(); revoke(embed)"
                      />
                    </div>
                  </div>
                </template>
              </UPopover>
            </div>
            <div
              v-else
              class="flex justify-end"
            >
              <UButton
                :label="t('common.delete')"
                icon="i-lucide-trash-2"
                size="xs"
                color="error"
                variant="ghost"
                @click="remove(embed)"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Live preview -->
      <div class="flex min-h-0 flex-1 justify-center overflow-auto rounded-lg bg-muted p-3">
        <UEmpty
          v-if="publishedOnce === false"
          icon="i-lucide-upload"
          :title="t('dashboards.embedDrawer.notPublished')"
          :description="t('dashboards.embedDrawer.notPublishedHelp')"
          variant="naked"
        />
        <UAlert
          v-else-if="previewError"
          color="error"
          variant="subtle"
          :title="previewError"
        />
        <div
          v-else-if="previewSrc"
          class="relative shrink-0"
          :class="widgetId ? 'h-60' : 'h-full min-h-[60vh]'"
          :style="{ width: DEVICE_WIDTH[device] }"
        >
          <iframe
            ref="previewFrame"
            :key="previewSrc"
            :src="previewSrc"
            :title="t('dashboards.embedDrawer.previewTitle')"
            class="h-full w-full rounded-lg border border-default bg-default transition-opacity"
            :class="previewLoading ? 'opacity-0' : 'opacity-100'"
            @load="onPreviewLoad"
          />
          <div
            v-if="previewLoading"
            class="absolute inset-0 flex items-center justify-center rounded-lg border border-default bg-default"
          >
            <UEmpty
              loading
              variant="naked"
              size="sm"
            />
          </div>
        </div>
        <UEmpty
          v-else
          loading
          variant="naked"
          size="sm"
        />
      </div>
    </div>
  </SettingsSection>
</template>
