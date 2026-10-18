<script setup lang="ts">
/**
 * Dashboard editor - single edit-mode page, entered from
 * DashboardsTree.vue's sidebar: its job is the canvas. Header layout (the
 * pattern Workflows and DataViews adopt too): actions on the object in a
 * "⋮" menu (Duplicate…, Delete…), then on the right content (Settings,
 * Refresh) | publishing (Unpublished badge, versions, Share, Publish last).
 *
 * Each widget persists on its own (add/edit/delete/move each make their
 * own API call, like DataView's Design form) - there's no batched draft
 * to Save. Its settings - General, Variables, Data, Share, Security - are
 * a page of their own (settings.vue, D26): Settings opens it, Share its
 * Share section, the ⚙ beside the variables bar its Variables.
 *
 * Versioning follows Specification.md §13, shared with DataViews
 * and Workflows: the canvas shows the DRAFT; opening a version from the
 * VersionsMenu swaps the canvas to that version's snapshot, read-only
 * (no palette, no edit/remove/drag, no Publish), with the
 * VersionPreviewBanner offering Rollback / Save as… / Back to draft.
 *
 * On a phone or a tablet (useCompactUi) the layout is fixed - nothing to
 * drag or resize with a finger, and in reading order on a phone (KPIs two to a row) -
 * but the content is not: a widget can still be edited (its query), added
 * (Add widget opens the palette) or removed.
 *
 * Above the canvas, Desktop / Tablet / Phone shows the dashboard at that
 * device's width and columns, as the viewer lays it out (DashboardView.vue:
 * 6 columns, then one). Only Desktop - the 12 columns that are saved - moves
 * and resizes; the others are a preview of the same layout.
 */
import type {
  Dashboard,
  DashboardTab,
  DashboardVersion,
  DashboardVersionSnapshot,
  DashboardWidget,
  DashboardWidgetContent,
  DashboardWidgetPaletteEntry
} from '~/types/dashboard'
import { useDashboardCatalogText } from '~/types/dashboard'
import { dashboardWidgetDefinition, newWidgetControlConfig } from '@totalbase/tb-catalog'
import { slugify } from '@totalbase/shared'
import { DASHBOARD_CANVAS_CONTEXT_KEY } from '~/composables/useDashboardCanvasContext'
import { decodeVariableValues, encodeVariableValues } from '~/utils/dashboard-variables'
import { DASHBOARD_DESIGN_COLUMNS, dashboardFlowLayout } from '~/utils/dashboard-layout'
import DashboardWidgetCard from '~/components/DashboardWidgetCard.vue'
import type { GridStack as GridStackCore, GridStackNode, GridStackWidget } from 'gridstack'
import { GridStack } from 'gridstack/dist/vue'
import 'gridstack/dist/gridstack.css'

const route = useRoute()
const router = useRouter()
const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const catalog = useDashboardCatalogText()
const { refresh: refreshTree } = useAppsNavDashboards()
const dashboardId = String(route.params.id)

const { data: dashboard, refresh: refreshDashboard } = await useAsyncData(
  `dashboard-${dashboardId}`,
  () => api.get<Dashboard>(`/dashboards/${dashboardId}`).then(r => r.data)
)
const { data: widgets, refresh: refreshWidgets } = await useAsyncData(
  `dashboard-widgets-${dashboardId}`,
  () => api.get<DashboardWidget[]>(`/dashboards/${dashboardId}/widgets`).then(r => r.data),
  { default: (): DashboardWidget[] => [] }
)
const { data: versions, refresh: refreshVersions } = await useAsyncData(
  `dashboard-versions-${dashboardId}`,
  () => api.get<DashboardVersion[]>(`/dashboards/${dashboardId}/versions`).then(r => r.data),
  { default: (): DashboardVersion[] => [] }
)
const liveVersion = computed(() => versions.value?.[0] ?? null) // newest first = live
const hasUnpublishedChanges = computed(() => dashboard.value?.hasUnpublishedChanges === true)
// The Dashboards sidebar badges each entry by this same status.
watch([() => liveVersion.value?.version ?? null, () => dashboard.value?.hasUnpublishedChanges], ([live, changed]) => {
  if (changed !== undefined) useAppsNavDashboards().patchStatus(dashboardId, { liveVersion: live, hasUnpublishedChanges: changed })
}, { immediate: true })

// Manual refresh (no polling): every mounted card watches this and re-runs its query.
const refreshKey = ref(0)

/** Any draft edit may change "Unpublished changes" - re-read it from the server (Specification.md §13.5) rather than guess client-side. */
function refreshStatus() {
  return refreshDashboard()
}

// --- Version preview (Specification.md §13.4) ---
const preview = ref<DashboardVersionSnapshot | null>(null)
const readOnly = computed(() => preview.value !== null)
const isCompact = useCompactUi()
const isMobile = useIsMobile()
/** The device the canvas shows - a phone window is always Phone; a tablet starts on Tablet. */
type CanvasDevice = 'desktop' | 'tablet' | 'phone'
const CANVAS_DEVICES: { value: CanvasDevice, icon: string, columns: number, width: string }[] = [
  { value: 'desktop', icon: 'i-lucide-monitor', columns: 12, width: '' },
  { value: 'tablet', icon: 'i-lucide-tablet', columns: 6, width: 'max-w-[768px]' },
  { value: 'phone', icon: 'i-lucide-smartphone', columns: 2, width: 'max-w-[390px]' }
]
const chosenDevice = ref<CanvasDevice>(isCompact.value ? 'tablet' : 'desktop')
const device = computed(() => CANVAS_DEVICES.find(d => d.value === (isMobile.value ? 'phone' : chosenDevice.value))!)
const deviceLabel = (value: CanvasDevice) => t(`dashboards.embedDrawer.devices.${value}`)
/** Widgets can't be moved or resized - a previewed version, a phone/tablet (fingers, not a mouse), or a Tablet/Phone preview. (Those can still edit, add and remove them; a version can't.) */
const layoutLocked = computed(() => readOnly.value || isCompact.value || device.value.columns !== 12)
/** A phone or tablet: the palette as a slideover, opened from the header's Add widget. */
const paletteOpen = ref(false)
async function selectVersion(version: number | null) {
  if (version === null) {
    preview.value = null
    return
  }
  try {
    const { data } = await api.get<DashboardVersionSnapshot>(`/dashboards/${dashboardId}/versions/${version}`)
    preview.value = data
  } catch (error) {
    notifyError(error, t('dashboards.editor.openVersionFailed'))
  }
}

// Restore (Specification.md §13.4): that version replaces the draft - nothing is published.
const restoring = ref(false)
async function restore() {
  if (!preview.value) return
  const version = preview.value.version
  restoring.value = true
  try {
    await api.post(`/dashboards/${dashboardId}/versions/${version}/restore`)
    preview.value = null
    await Promise.all([refreshWidgets(), refreshVersions(), refreshStatus()])
    refreshKey.value++
    toast.add({ title: t('dashboards.editor.restored', { version }), description: t('dashboards.editor.restoredHelp'), color: 'success' })
  } catch (error) {
    notifyError(error, t('dashboards.editor.restoreFailed'))
  } finally {
    restoring.value = false
  }
}

// Duplicate (D26): a copy of the draft - its widgets and variables - unpublished, opened by no role.
const duplicateOpen = ref(false)
const duplicating = ref(false)
async function duplicate(input: { name: string, slug: string }) {
  duplicating.value = true
  try {
    await autosave.flush()
    const { data } = await api.post<Dashboard>(`/dashboards/${dashboardId}/duplicate`, { data: input })
    duplicateOpen.value = false
    await refreshTree()
    toast.add({ title: t('dashboards.editor.copyCreated', { name: data.name }), description: t('dashboards.editor.copyCreatedHelp'), color: 'success' })
    await navigateTo(`/dashboards/${data.id}`)
  } catch (error) {
    notifyError(error, t('dashboards.editor.copyFailed'))
  } finally {
    duplicating.value = false
  }
}

const saveAsOpen = ref(false)
const savingAs = ref(false)
async function saveAs(input: { name: string, slug: string }) {
  if (!preview.value) return
  savingAs.value = true
  try {
    const { data } = await api.post<Dashboard>(`/dashboards/${dashboardId}/versions/${preview.value.version}/duplicate`, { data: input })
    saveAsOpen.value = false
    await refreshTree()
    toast.add({ title: t('dashboards.editor.copyCreated', { name: data.name }), description: t('dashboards.editor.copyCreatedHelp'), color: 'success' })
    await navigateTo(`/dashboards/${data.id}`)
  } catch (error) {
    notifyError(error, t('dashboards.editor.copyFailed'))
  } finally {
    savingAs.value = false
  }
}

// What the canvas and variables bar show: the previewed version's snapshot, or the draft.
const allWidgets = computed(() => preview.value?.widgets ?? widgets.value ?? [])
// Tabs (D7): one grid per tab - the canvas shows the open one's widgets (a widget without one is the first's).
const tabs = computed(() => (preview.value ? preview.value.tabs : dashboard.value?.tabs) ?? [])
const chosenTab = ref<string | undefined>(typeof route.query.tab === 'string' ? route.query.tab : undefined)
const activeTab = computed({
  get: () => (tabs.value.some(tab => tab.value === chosenTab.value) ? chosenTab.value : tabs.value[0]?.value),
  set: (value) => {
    chosenTab.value = value
  }
})
const tabOf = (widget: DashboardWidgetContent) => widget.tab ?? tabs.value[0]?.value
const displayedWidgets = computed(() => allWidgets.value.filter(widget => !tabs.value.length || tabOf(widget) === activeTab.value))
const tabCounts = computed(() => Object.fromEntries(tabs.value.map(tab => [tab.value, allWidgets.value.filter(widget => tabOf(widget) === tab.value).length])))
async function saveTabs(next: DashboardTab[]) {
  const { data } = await autosave.track(api.patch<Dashboard>(`/dashboards/${dashboardId}`, { data: { tabs: next } }))
  if (dashboard.value) dashboard.value = { ...dashboard.value, tabs: data.tabs }
  // No tabs left: every widget joins the one grid.
  if (!next.length) widgets.value = (widgets.value ?? []).map(widget => ({ ...widget, tab: null }))
  refreshStatus()
}
async function addTab(label: string) {
  const taken = new Set(tabs.value.map(tab => tab.value))
  const base = slugify(label).replace(/^[^a-z]+/, '').slice(0, 28) || 'tab'
  let value = base
  for (let i = 2; taken.has(value); i++) value = `${base}-${i}`
  try {
    await saveTabs([...tabs.value, { value, label }])
    activeTab.value = value
  } catch (error) {
    notifyError(error, t('dashboards.tabs.saveFailed'))
  }
}
async function renameTab(value: string, label: string) {
  try {
    await saveTabs(tabs.value.map(tab => (tab.value === value ? { ...tab, label } : tab)))
  } catch (error) {
    notifyError(error, t('dashboards.tabs.saveFailed'))
  }
}
/** Removes a tab - its widgets moved to `moveTo` first (or, the last tab, joined in one grid). */
async function removeTab(value: string, moveTo: string | null) {
  try {
    if (moveTo) {
      for (const widget of allWidgets.value.filter(w => tabOf(w) === value)) await moveWidgetToTab(widget, moveTo)
    }
    const rest = tabs.value.filter(tab => tab.value !== value)
    await saveTabs(rest)
    activeTab.value = moveTo ?? rest[0]?.value
  } catch (error) {
    notifyError(error, t('dashboards.tabs.saveFailed'))
  }
}
async function moveWidgetToTab(widget: DashboardWidgetContent, tab: string) {
  // Below what the tab already holds.
  const bottom = allWidgets.value.filter(w => w.id !== widget.id && tabOf(w) === tab).reduce((max, w) => Math.max(max, w.gridY + w.gridH), 0)
  const { data } = await autosave.track(api.patch<DashboardWidget>(`/dashboards/${dashboardId}/widgets/${widget.id}`, { data: { tab, gridY: bottom } }))
  widgets.value = (widgets.value ?? []).map(w => (w.id === data.id ? data : w))
  refreshStatus()
}
const variables = computed(() => preview.value?.variables ?? dashboard.value?.variables ?? [])

// --- Variables ($VAR.*) - values in the bar, mirrored in the URL so a shared link shows the same view ---
const variableValues = ref<Record<string, unknown>>(decodeVariableValues(variables.value, route.query))
/** What the bar shows for each value - the formulas' `{{vars.<name>.label}}` (D3). */
const variableLabels = ref<Record<string, string>>({})
const session = useSession()
watch(variableValues, (values) => {
  router.replace({ query: encodeVariableValues(variables.value, values) })
})
/** The settings page, at one of its sections (D26). */
function openSettings(section?: 'variables' | 'share') {
  void navigateTo({ path: `/dashboards/${dashboardId}/settings`, query: section ? { section } : {} })
}
async function loadVariableOptions(name: string, values: Record<string, unknown>) {
  const path = preview.value
    ? `/dashboards/${dashboardId}/versions/${preview.value.version}/variables/${name}/options`
    : `/dashboards/${dashboardId}/variables/${name}/options`
  const { data } = await api.post<{ value: string, label: string }[]>(path, { data: { variables: values } })
  return data
}

// --- Autosave (useAutosave.ts): every canvas edit (add, move, resize,
// remove a widget) is written to the draft immediately - `track` only
// reports it in the header's SaveStatus. Publish flushes first. ---
const autosave = useAutosave(async () => {})
/** After a failed save: reload the draft as the server has it, so the canvas shows what's really saved. */
async function resyncDraft() {
  await Promise.all([refreshWidgets(), refreshStatus()])
  autosave.status.value = 'idle'
}

// --- Publish ---
const publishing = ref(false)
// Embeds a publish would stop (Specification_Dashboards.md §9.5): they lock a variable the draft no longer has - checked as the confirmation opens.
const brokenEmbeds = ref<{ name: string, missing: string[] }[]>([])
async function checkEmbeds() {
  brokenEmbeds.value = []
  try {
    await autosave.flush()
    brokenEmbeds.value = (await api.get<{ name: string, missing: string[] }[]>(`/dashboards/${dashboardId}/embeds/impact`)).data
  } catch {
    // The check is advice; the publish itself is unaffected.
  }
}
async function publish(note?: string) {
  publishing.value = true
  try {
    await autosave.flush()
    const { data } = await api.post<DashboardVersion>(`/dashboards/${dashboardId}/publish`, note ? { data: { note } } : undefined)
    await Promise.all([refreshVersions(), refreshStatus()])
    toast.add({ title: t('dashboards.editor.published', { version: data.version }), color: 'success' })
  } catch (error) {
    notifyError(error, t('dashboards.editor.publishFailed'))
  } finally {
    publishing.value = false
  }
}

// --- Object actions: the "⋯" menu next to the title (settings, delete) -
// kept apart from the everyday canvas/publish actions on the right. ---
const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
watch(deleteOpen, (isOpen) => {
  if (isOpen) deleteConfirmed.value = false
})
const objectMenuItems = computed(() => [
  [
    { label: t('dashboards.editor.duplicate'), icon: 'i-lucide-copy', onSelect: () => { duplicateOpen.value = true } }
  ],
  [{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { deleteOpen.value = true } }]
])

// Header secondary actions - what you use while building the canvas.
// Buttons on desktop, PageHeader's "⋮" on a phone, where the versions
// chip moves too (versionsMobileMenu).
const headerActions = computed<HeaderAction[]>(() => [
  ...(readOnly.value
    ? []
    : [
        ...(isCompact.value ? [{ label: t('dashboards.editor.addWidget'), icon: 'i-lucide-plus', onSelect: () => { paletteOpen.value = true } }] : [])
      ]),
  { label: t('common.refresh'), icon: 'i-lucide-refresh-cw', onSelect: () => { refreshKey.value++ } }
])
const { mobileMenu: versionsMobileMenu } = useVersionMenu(() => versions.value ?? [], () => preview.value?.version ?? null, selectVersion, openDeleteVersions)
// Settings › Versions opens a version here: `?version=N` previews it.
onMounted(() => {
  const asked = Number(route.query.version)
  if (asked) void selectVersion(asked)
})
// "Delete old versions…" (Specification.md §13.4): a preview of a deleted version goes back to the draft.
const deleteVersionsOpen = ref(false)
function openDeleteVersions() {
  deleteVersionsOpen.value = true
}
async function onVersionsDeleted(deleted: number[]) {
  const viewing = preview.value?.version
  if (viewing !== undefined && deleted.includes(viewing)) await selectVersion(null)
  await refreshVersions()
}

// --- Delete ---
const deleting = ref(false)
async function deleteDashboard() {
  deleting.value = true
  try {
    await api.del(`/dashboards/${dashboardId}`)
    deleteOpen.value = false
    await refreshTree()
    await navigateTo('/dashboards')
  } catch (error) {
    notifyError(error, t('dashboards.editor.deleteFailed'))
  } finally {
    deleting.value = false
  }
}

// --- Widgets (draft) ---
/** A card's Delete… asks first - a widget's query goes with it. */
const widgetToDelete = ref<DashboardWidgetContent | null>(null)
/** The delete modal's Confirm - Delete enables only once it is checked (AGENTS.md §25). */
const deleteWidgetConfirmed = ref(false)
watch(widgetToDelete, (widget) => {
  if (widget) deleteWidgetConfirmed.value = false
})
const deletingWidget = ref(false)
function askDeleteWidget(widget: DashboardWidgetContent) {
  widgetToDelete.value = widget
}
async function deleteWidget() {
  const widget = widgetToDelete.value
  if (!widget) return
  deletingWidget.value = true
  try {
    await autosave.track(api.del(`/dashboards/${dashboardId}/widgets/${widget.id}`))
    widgets.value = (widgets.value ?? []).filter(w => w.id !== widget.id)
    widgetToDelete.value = null
    refreshStatus()
  } catch (error) {
    notifyError(error, t('dashboards.editor.removeWidgetFailed'))
  } finally {
    deletingWidget.value = false
  }
}
/** A copy at the bottom of the canvas: its type, size, query and config - created configured, in one call. */
async function duplicateWidget(widget: DashboardWidgetContent) {
  try {
    const { data: copy } = await autosave.track(api.post<DashboardWidget>(`/dashboards/${dashboardId}/widgets`, {
      data: {
        type: widget.type,
        label: t('dashboards.editor.copyLabel', { label: widget.label || catalog.widgetLabel(widget.type) }),
        gridX: widget.gridX,
        gridY: nextGridY.value,
        gridW: widget.gridW,
        gridH: widget.gridH,
        query: widget.query,
        config: widget.config,
        tab: widget.tab ?? null
      }
    }))
    widgets.value = [...(widgets.value ?? []), copy]
    refreshStatus()
  } catch (error) {
    notifyError(error, t('dashboards.editor.duplicateWidgetFailed'))
  }
}

const editingWidget = ref<DashboardWidgetContent | null>(null)
const drawerOpen = ref(false)
function editWidget(widget: DashboardWidgetContent) {
  editingWidget.value = widget
  drawerOpen.value = true
}
function onWidgetSaved(saved: DashboardWidget) {
  widgets.value = (widgets.value ?? []).map(w => (w.id === saved.id ? saved : w))
  refreshStatus()
}

provide(DASHBOARD_CANVAS_CONTEXT_KEY, {
  dashboardId,
  widgets: displayedWidgets,
  onEdit: editWidget,
  onDelete: askDeleteWidget,
  onDuplicate: duplicateWidget,
  refreshKey,
  variableValues,
  variables,
  variableLabels,
  user: computed(() => session.admin.value),
  readOnly,
  tabs,
  onMoveToTab: (widget, tab) => {
    moveWidgetToTab(widget, tab).catch((error) => {
      notifyError(error, t('dashboards.editor.moveWidgetFailed'))
    })
  },
  dataPath: widget => (preview.value
    ? `/dashboards/${dashboardId}/versions/${preview.value.version}/widgets/${widget.id}/data`
    : `/dashboards/${dashboardId}/widgets/${widget.id}/data`)
})

// --- Canvas (GridStack) - same wiring as DataView's Design form ---
const gridRef = ref<{ getGrid(): GridStackCore | null } | null>(null)
function liveGrid(): GridStackCore | null {
  return gridRef.value?.getGrid() ?? null
}
// `draggable.handle`: only a card's header drags (DashboardWidgetCard.vue),
// so pointer interaction with a chart body shows its tooltips instead.
// 12 columns on Desktop - the design surface, the one layout saved - and
// the device's columns otherwise, re-flowed from those 12 as the viewer
// does (dashboardFlowLayout). A column change fires GridStack's `change`
// with re-flowed positions, so onGridChange ignores it (`reflowing`) and
// only ever persists a 12-column layout.
const DESIGN_COLUMNS = DASHBOARD_DESIGN_COLUMNS
const flowLayout = dashboardFlowLayout((id) => {
  const widget = displayedWidgets.value.find(w => w.id === id)
  return widget && { x: widget.gridX, y: widget.gridY, w: widget.gridW, mobile: widget.config?.mobile }
})
const gridOptions = {
  column: DESIGN_COLUMNS,
  cellHeight: 72,
  margin: 8,
  float: false,
  draggable: { handle: '.dashboard-widget-drag-handle' }
}
const gridComponents = { DashboardWidgetCard }
// The Phone preview leaves out what a phone doesn't show (D23).
const gridWidgets = computed<GridStackWidget[]>(() => displayedWidgets.value.filter(widget => !(device.value.value === 'phone' && widget.config?.mobile === 'HIDDEN')).map(widget => ({
  id: widget.id,
  x: widget.gridX,
  y: widget.gridY,
  w: widget.gridW,
  h: widget.gridH,
  // Never smaller than its type allows (DB11) - the 12 columns that are saved; the previews re-flow it. A preview
  // sets its own minimum: GridStack keeps a loaded node's minW, and a KPI's 2 of 12 held it to the phone's whole row.
  ...(device.value.columns === DESIGN_COLUMNS ? { minW: dashboardWidgetDefinition(widget.type).minSize.w, minH: dashboardWidgetDefinition(widget.type).minSize.h } : { minW: 1, minH: 1 }),
  component: 'DashboardWidgetCard',
  props: { widgetId: widget.id }
})))
let reflowing = false
function syncGridWidgets() {
  const grid = liveGrid()
  if (!grid) return
  reflowing = true
  // Load the saved 12-column layout, then re-flow it to the device's columns.
  grid.column(DESIGN_COLUMNS, flowLayout)
  grid.load(gridWidgets.value)
  grid.column(device.value.columns, flowLayout)
  reflowing = false
  // A locked layout can't be rearranged - static also disables resize handles.
  grid.setStatic(layoutLocked.value)
}
watch([gridWidgets, layoutLocked, () => device.value.columns], syncGridWidgets, { deep: true })
onMounted(() => nextTick(syncGridWidgets))

/**
 * A drag or a resize moved these widgets (one dragged, the rest pushed
 * aside): one PATCH per widget, all in flight at once rather than one
 * after the other - there is no layout endpoint to save them in one
 * request. One toast if any failed, and the canvas goes back to the
 * saved layout then.
 */
async function onGridChange(_event: Event, nodes: GridStackNode[]) {
  if (reflowing || layoutLocked.value || liveGrid()?.getColumn() !== DESIGN_COLUMNS) return
  const changed = nodes.flatMap((node) => {
    const widget = (widgets.value ?? []).find(w => w.id === node.id)
    return !widget || (widget.gridX === node.x && widget.gridY === node.y && widget.gridW === node.w && widget.gridH === node.h) ? [] : [{ widget, node }]
  })
  if (changed.length === 0) return
  const results = await Promise.allSettled(changed.map(async ({ widget, node }) => {
    await autosave.track(api.patch(`/dashboards/${dashboardId}/widgets/${widget.id}`, { data: { gridX: node.x, gridY: node.y, gridW: node.w, gridH: node.h } }))
    widget.gridX = node.x!
    widget.gridY = node.y!
    widget.gridW = node.w!
    widget.gridH = node.h!
  }))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    notifyError(failed.reason, t('dashboards.editor.moveWidgetFailed'))
    syncGridWidgets() // revert the visual drag to the last known-good layout.
  }
  if (results.some(r => r.status === 'fulfilled')) refreshStatus()
}

// --- Add a widget: inserted unconfigured at the bottom, configured from its card ---
const nextGridY = computed(() => displayedWidgets.value.reduce((max, w) => Math.max(max, w.gridY + w.gridH), 0))
const adding = ref(false)
async function addWidget(entry: DashboardWidgetPaletteEntry) {
  adding.value = true
  try {
    // A presentation widget starts as a page places it - its text its name (newWidgetControlConfig).
    const page = dashboardWidgetDefinition(entry.type).page
    const props = page ? newWidgetControlConfig(page).props : {}
    const { data } = await autosave.track(api.post<DashboardWidget>(`/dashboards/${dashboardId}/widgets`, {
      data: { type: entry.type, gridX: 0, gridY: nextGridY.value, gridW: entry.size.w, gridH: entry.size.h, ...(Object.keys(props).length && { config: { props } }), ...(tabs.value.length && { tab: activeTab.value }) }
    }))
    widgets.value = [...(widgets.value ?? []), data]
    paletteOpen.value = false
    refreshStatus()
  } catch (error) {
    notifyError(error, t('dashboards.editor.addWidgetFailed'))
  } finally {
    adding.value = false
  }
}
// A data widget without a query - a presentation widget needs none.
const unconfiguredCount = computed(() => (widgets.value ?? []).filter(w => !w.query && !dashboardWidgetDefinition(w.type).page).length)
</script>

<template>
  <PageShell :scroll="false">
    <template #header>
      <PageHeader
        :title="dashboard?.name ?? 'Dashboard'"
        :description="dashboard?.description ?? t('dashboards.editor.canvas')"
        :icon="dashboard?.icon ?? 'i-lucide-layout-dashboard'"
        height="editor"
        :actions="headerActions"
        :menu="readOnly ? undefined : objectMenuItems"
        :mobile-menu="versionsMobileMenu"
      >
        <template #status>
          <SaveStatus
            v-if="!readOnly"
            :status="autosave.status.value"
            @retry="resyncDraft"
          />
        </template>
        <!-- The other screen (Specification_Admin_UI.md §3.7), then publishing: state, versions, the primary action last. -->
        <UButton
          v-if="!readOnly"
          icon="i-lucide-settings"
          :label="t('common.settings')"
          color="neutral"
          variant="outline"
          @click="openSettings()"
        />
        <UnpublishedChangesBadge
          v-if="hasUnpublishedChanges && !readOnly"
        />
        <VersionsMenu
          :versions="versions ?? []"
          :viewing="preview?.version ?? null"
          @select="selectVersion"
          @delete-old="deleteVersionsOpen = true"
        />
        <DiagnosisBadge
          v-if="!readOnly"
          :key="`diagnosis-${(liveVersion?.version ?? 0)}`"
          kind="dashboard"
          :object-id="dashboardId"
        />
        <PublishButton
          v-if="!readOnly"
          :diagnosis="{ kind: 'dashboard', objectId: dashboardId }"
          :loading="publishing"
          :disabled="!hasUnpublishedChanges"
          :next-version="(liveVersion?.version ?? 0) + 1"
          :note="t('dashboards.editor.publishHelp')"
          @open="checkEmbeds"
          @publish="publish"
        >
          <p
            v-if="unconfiguredCount > 0"
            class="text-xs text-warning"
          >
            {{ t('dashboards.editor.unconfigured', unconfiguredCount) }}
          </p>
          <p
            v-if="brokenEmbeds.length"
            class="text-xs text-error"
          >
            {{ t('dashboards.editor.brokenEmbeds', { n: brokenEmbeds.length, names: brokenEmbeds.map(e => `"${e.name}"`).join(', '), variables: [...new Set(brokenEmbeds.flatMap(e => e.missing))].join(', ') }, brokenEmbeds.length) }}
          </p>
        </PublishButton>
      </PageHeader>
    </template>

    <VersionPreviewBanner
      v-if="preview"
      :version="preview.version"
      :published-at="preview.publishedAt"
      :is-live="preview.version === liveVersion?.version"
      :has-unpublished-changes="hasUnpublishedChanges"
      :restoring="restoring"
      @restore="restore"
      @save-as="saveAsOpen = true"
      @back="selectVersion(null)"
    />

    <div
      v-if="dashboard"
      class="flex flex-1 min-h-0 gap-4"
    >
      <!-- Widget palette - a column on desktop (hidden while a version is
      previewed), a slideover on a phone (below). -->
      <div
        v-if="!readOnly && !isCompact"
        class="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto border-r border-default pr-4"
      >
        <h3 class="mb-1 text-xs font-medium uppercase text-muted">
          {{ t('dashboards.editor.widgets') }}
        </h3>
        <DashboardWidgetPalette
          :disabled="adding"
          @add="addWidget"
        />
      </div>
      <USlideover
        v-if="isCompact && !readOnly"
        v-model:open="paletteOpen"
        side="left"
        :title="t('dashboards.editor.addAWidget')"
        :ui="{ content: 'max-w-sm' }"
      >
        <template #body>
          <DashboardWidgetPalette
            :disabled="adding"
            @add="addWidget"
          />
        </template>
      </USlideover>

      <!-- Canvas: cards are mounted by GridStack (gridWidgets/gridComponents), not rendered here. -->
      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <p
          v-if="isCompact && !readOnly"
          class="flex items-center gap-1.5 text-xs text-muted"
        >
          <UIcon
            name="i-lucide-monitor"
            class="size-3.5 shrink-0"
          />
          {{ t('dashboards.editor.largerScreen') }}
        </p>
        <p
          v-else-if="!readOnly && device.columns !== DESIGN_COLUMNS"
          class="flex items-center gap-1.5 text-xs text-muted"
        >
          <UIcon
            :name="device.icon"
            class="size-3.5 shrink-0"
          />
          {{ t('dashboards.editor.devicePreview', { device: deviceLabel(device.value) }) }}
        </p>
        <div
          v-if="variables.length || !isMobile || !readOnly"
          class="flex items-end justify-between gap-3"
        >
          <div class="flex min-w-0 items-end gap-1">
            <DashboardVariablesBar
              v-if="variables.length"
              v-model="variableValues"
              v-model:labels="variableLabels"
              :variables="variables"
              :load-options="loadVariableOptions"
            />
            <!-- Its variables are edited in Settings › Variables (D26). -->
            <UTooltip
              v-if="!readOnly"
              :text="t('dashboards.editor.editVariables')"
            >
              <UButton
                icon="i-lucide-settings"
                :label="variables.length ? undefined : t('dashboards.editor.editVariables')"
                color="neutral"
                variant="ghost"
                :aria-label="t('dashboards.editor.editVariables')"
                @click="openSettings('variables')"
              />
            </UTooltip>
          </div>
          <!-- The device the canvas shows - Tablet and Phone preview the viewer's layout. -->
          <UFieldGroup
            v-if="!isMobile"
            class="ml-auto shrink-0"
          >
            <UTooltip
              v-for="option in CANVAS_DEVICES"
              :key="option.value"
              :text="option.value === 'desktop' ? t('dashboards.editor.desktopTooltip') : t('dashboards.editor.deviceTooltip', { device: deviceLabel(option.value), n: option.columns }, option.columns)"
            >
              <UButton
                :icon="option.icon"
                :aria-label="deviceLabel(option.value)"
                color="neutral"
                :variant="device.value === option.value ? 'soft' : 'ghost'"
                size="sm"
                @click="chosenDevice = option.value"
              />
            </UTooltip>
          </UFieldGroup>
        </div>
        <DashboardTabsBar
          v-if="tabs.length || !readOnly"
          v-model="activeTab"
          :tabs="tabs"
          :read-only="readOnly"
          :counts="tabCounts"
          @add="addTab"
          @rename="renameTab"
          @remove="removeTab"
        />
        <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-default bg-elevated/30 p-3">
          <div
            class="mx-auto w-full"
            :class="device.width"
          >
            <GridStack
              ref="gridRef"
              :options="gridOptions"
              :components="gridComponents"
              @change="onGridChange"
            />
          </div>
          <p
            v-if="displayedWidgets.length === 0"
            class="p-6 text-center text-sm text-muted"
          >
            {{ readOnly ? t('dashboards.editor.versionEmpty') : isCompact ? t('dashboards.editor.emptyCompact') : t('dashboards.editor.empty') }}
          </p>
        </div>
      </div>
    </div>

    <DashboardWidgetDrawer
      v-model:open="drawerOpen"
      :dashboard-id="dashboardId"
      :widget="editingWidget"
      :variable-values="variableValues"
      :variable-labels="variableLabels"
      :variables="variables"
      @saved="onWidgetSaved"
    />

    <!-- Delete lives in the "⋯" menu, so there's no button to anchor a
    popover to - a small modal instead, with AGENTS.md §25's "Confirm"
    checkbox in the footer. -->
    <UModal
      v-model:open="deleteOpen"
      :title="t('dashboards.editor.deleteTitle')"
      :description="t('dashboards.editor.deleteHelp', { name: dashboard?.name ?? t('dashboards.editor.thisDashboard') })"
    >
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UCheckbox
            v-model="deleteConfirmed"
            :label="t('common.confirm')"
          />
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            />
            <UButton
              :label="t('common.delete')"
              color="error"
              :loading="deleting"
              :disabled="!deleteConfirmed"
              @click="deleteDashboard"
            />
          </div>
        </div>
      </template>
    </UModal>
    <!-- A widget's Delete… (its card's "⋮") - it goes from the draft with its query. -->
    <UModal
      :open="widgetToDelete !== null"
      :title="t('dashboards.editor.deleteWidgetTitle')"
      :description="t('dashboards.editor.deleteWidgetHelp', { name: widgetToDelete?.label || (widgetToDelete ? catalog.widgetLabel(widgetToDelete.type) : '') })"
      @update:open="(isOpen: boolean) => { if (!isOpen) widgetToDelete = null }"
    >
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <label class="flex cursor-pointer items-center gap-2">
            <UCheckbox v-model="deleteWidgetConfirmed" />
            <span class="text-sm">{{ t('common.confirm') }}</span>
          </label>
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="deletingWidget"
              @click="widgetToDelete = null"
            />
            <UButton
              :label="t('common.delete')"
              color="error"
              :disabled="!deleteWidgetConfirmed"
              :loading="deletingWidget"
              @click="deleteWidget"
            />
          </div>
        </div>
      </template>
    </UModal>

    <VersionSaveAsModal
      v-if="dashboard"
      v-model:open="duplicateOpen"
      :source-label="dashboard.name"
      :loading="duplicating"
      @submit="duplicate"
    />
    <VersionSaveAsModal
      v-if="preview && dashboard"
      v-model:open="saveAsOpen"
      :source-label="`${dashboard.name} v${preview.version}`"
      :loading="savingAs"
      @submit="saveAs"
    />
    <DeleteVersionsModal
      v-model:open="deleteVersionsOpen"
      pillar="dashboards"
      :object-id="dashboardId"
      :versions="versions ?? []"
      @deleted="onVersionsDeleted"
    />
  </PageShell>
</template>
