<script setup lang="ts">
// Type-only imports (unlike every other component here, otherwise all
// auto-imported) - `InstanceType<typeof DataViewGrid>` below needs the
// real symbol in scope; Nuxt's auto-import only registers the component
// for TEMPLATE usage, not as a type-level value (same fix `BindingButton.
// vue` needed for `FormulaEditor`). `import type` keeps them out of this
// route's chunk: the grid is auto-imported, and a CUSTOM page's runtime
// (CustomPage, the whole widget catalog) and the EXTERNALFRAME load only
// for a DataView of that kind, below.
import type DataViewGrid from '~/components/DataViewGrid.vue'
import type DataViewExternalFrameComponent from '~/components/DataViewExternalFrame.vue'
import { PAGE_FOOTER_SLOT } from '@totalbase/tb-catalog'
import { embeddableFrameUrl } from '~/utils/frame-url'
import { dataviewIcon, FORM_LIKE_DATAVIEW_TYPES, LIST_MARGIN_CLASS, pageContentClassOf, resolveFrameUrl, resolveLayouts, resolveKiosk, resolveListMargin, resolveSettingsLayout } from '~/types/dataview'

const CustomPage = defineAsyncComponent(() => import('~/components/CustomPage.vue'))
const DataViewExternalFrame = defineAsyncComponent(() => import('~/components/DataViewExternalFrame.vue'))

const isCompact = useCompactUi()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
/** A shared saved view's link (`?view=<id>`) applies once: the param goes after, so a reload doesn't reapply it. */
function dropSharedView() {
  const { view: _discard, ...rest } = route.query
  void router.replace({ query: rest })
}
/** A link's filter (`?filter=`, a dashboard's click) applies once the same way - the grid keeps it as chips. */
function dropLinkFilter() {
  const { filter: _discard, ...rest } = route.query
  void router.replace({ query: rest })
}
const slug = computed(() => route.params.slug as string)
// `?draft=true`: the draft, framed by the editor's device preview (administrators only).
const draft = computed(() => route.query.draft === 'true')

const { dataview, fields, pending, fieldsPending, error, primaryKey, canWrite, canCreate, canDelete, features, editPresentation, editSize, editSide, baseWhere, autoRefresh, defaultState, cardLayout, mapLayout, mapView, kanbanLayout, calendarLayout, ganttLayout, treeLayout } = usePublishedDataViewBySlug(slug, draft)

// Standalone layout: "New" and bulk-selection actions live in PageHeader's
// own action slot instead of DataViewGrid's inline toolbar - see that
// component's `layout` prop doc comment. Reached through a template ref
// since selection state (selectedCount) lives inside the grid itself.
const gridRef = ref<InstanceType<typeof DataViewGrid> | null>(null)
// A CUSTOM page's table is its record's - the page draws itself, never a grid (nor the grid's New).
const gridReady = computed(() => !!(dataview.value && dataview.value.viewType !== 'CUSTOM' && !isSettings.value && dataview.value.sourceResourceSchema && dataview.value.sourceResourceName))
/** SETTINGS: its parameter table laid out like Settings, edited in place - never a grid. */
const isSettings = computed(() => dataview.value?.viewType === 'SETTINGS')
/** A list's margin (DataViews.md §5): the DataView's own, else the instance's - none by default. */
/** The view on screen - a DataView offering several (view_config.layouts) switches between them in its grid. */
const activeLayout = ref<string | null>(null)
const listMargin = computed(() => (dataview.value ? resolveListMargin({ ...dataview.value, viewType: (activeLayout.value ?? dataview.value.viewType) as typeof dataview.value.viewType }) : null))
const listMarginClass = computed(() => (listMargin.value ? LIST_MARGIN_CLASS[listMargin.value] : undefined))
const selectedCount = computed(() => gridRef.value?.selectedCount ?? 0)

// Template: a FORM DataView is an entirely different layout (one record
// form, no grid) - DataViewRecordPage.vue is a page frame of its own, so it
// replaces this page's whole PageShell rather than fitting inside it.
// Rows selected in the grid: the header shows the selection, the DataView's own actions for it and its bulk Delete.
const headerSelection = computed<HeaderSelection>(() => ({
  count: gridReady.value ? selectedCount.value : 0,
  summary: gridRef.value?.selectionSummary ?? null,
  actions: [
    ...(gridRef.value?.selectionActions ?? []),
    ...(canDelete.value ? [{ label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => gridRef.value?.requestBulkDelete() }] : [])
  ],
  onClear: () => gridRef.value?.clearSelection()
}))

// EXTERNALFRAME: an embedded page, no grid - its only header actions are
// the two optional features (Open in new tab, Fullscreen).
const isFrame = computed(() => dataview.value?.viewType === 'EXTERNALFRAME')
// CUSTOM: widgets bound to variables - its own page body, scrolling like any page.
const isCustom = computed(() => dataview.value?.viewType === 'CUSTOM')
/** A CUSTOM page with widgets in its footer gets the page's pinned footer (CustomPage.vue's Teleport) - none, no footer. */
/** Its content width and align (DataViews.md §6.7) - its body and its pinned footer; its header's widgets stay in the page header. */
const customContentClass = computed(() => dataview.value ? pageContentClassOf(dataview.value, 'custom') : undefined)
const hasPageFooter = computed(() => isCustom.value && (fields.value ?? []).some(f => f.kind === 'WIDGET' && f.parent === null && (f.config as { slot?: string }).slot === PAGE_FOOTER_SLOT))
/**
 * Kiosk (`view_config.kiosk`, CUSTOM - DataViews.md §7.3): the
 * page alone, no App menu and no page header - the layout steps aside
 * (`setPageLayout('kiosk')`) and KioskFrame fills the screen. An administrator
 * leaves it from its corner menu (`?kiosk=false`, the page in the App's
 * frame) and comes back from the header; never in the editor's device
 * preview (`?draft`). Its header widgets show inline, its footer at the
 * bottom of what scrolls.
 */
const session = useSession()
const isAdmin = computed(() => session.access.value === 'ADMIN')
const kioskConfigured = computed(() => !error.value && isCustom.value && !draft.value && resolveKiosk(dataview.value!.viewConfig))
const kiosk = computed(() => kioskConfigured.value && !(isAdmin.value && route.query.kiosk === 'false'))
watch(kiosk, (on, was) => {
  if (on || was) setPageLayout(on ? 'kiosk' : 'default')
}, { immediate: true })
function exitKiosk() {
  void router.replace({ query: { ...route.query, kiosk: 'false' } })
}
function openKiosk() {
  const { kiosk: _discard, ...rest } = route.query
  void router.replace({ query: rest })
}
const kioskActions = computed<HeaderAction[]>(() => (kioskConfigured.value && !kiosk.value
  ? [{ label: t('dataviews.kiosk.openKiosk'), icon: 'i-lucide-monitor', onSelect: openKiosk }]
  : []))
const frameUrl = computed(() => isFrame.value ? resolveFrameUrl(dataview.value!.viewConfig) : '')
const frameRef = ref<InstanceType<typeof DataViewExternalFrameComponent> | null>(null)
const frameActions = computed<HeaderAction[]>(() => {
  const url = embeddableFrameUrl(frameUrl.value)
  if (!isFrame.value || !url) return []
  const actions: HeaderAction[] = []
  if (features.value.fullscreen) actions.push({ label: t('dataviews.meta.featureLabels.fullscreen'), icon: 'i-lucide-maximize', iconOnly: true, onSelect: () => frameRef.value?.enterFullscreen() })
  if (features.value.openInNewTab) actions.push({ label: t('dataviews.meta.featureLabels.openInNewTab'), icon: 'i-lucide-external-link', iconOnly: true, onSelect: () => window.open(url, '_blank', 'noopener,noreferrer') })
  return actions
})
</script>

<template>
  <KioskFrame
    v-if="kiosk"
    :can-exit="isAdmin"
    @exit="exitKiosk"
  >
    <div :class="customContentClass">
      <CustomPage
        v-if="fields"
        :key="`${dataview!.id}-${dataview!.liveVersion}`"
        :dataview="dataview!"
        :fields="fields"
        :params="route.query"
      />
    </div>
  </KioskFrame>
  <DataViewRecordPage
    v-else-if="!error && dataview && fields && FORM_LIKE_DATAVIEW_TYPES.includes(dataview.viewType)"
    :key="`${dataview.id}-${dataview.liveVersion}`"
    :dataview="dataview"
    :fields="fields"
  />
  <PageShell
    v-else
    :scroll="isCustom || isSettings"
    :flush="isFrame || gridReady"
  >
    <template
      v-if="!error"
      #header
    >
      <PageHeader
        :title="dataview?.name ?? ''"
        :description="dataview?.description ?? undefined"
        :icon="dataview ? dataviewIcon(dataview) : undefined"
        :selection="headerSelection"
        :actions="[...frameActions, ...kioskActions]"
      >
        <!-- Compact toolbar mode's two Teleport targets (DataViewGrid.vue's
        own `compactSearchTarget`/`compactActionsTarget` props) - Search
        in the header's search slot, the "⋮" actions menu after New, when
        the toolbar is compact (always on a phone). Both empty (and
        harmless) in 'full' mode. -->
        <template #search>
          <div
            id="dataview-compact-search"
            class="flex items-center gap-2"
          />
        </template>
        <!-- On a phone or a tablet, New is its icon: the title keeps the room (T53). -->
        <UButton
          v-if="gridReady && canCreate && selectedCount === 0"
          icon="i-lucide-plus"
          :label="isCompact ? undefined : t('common.new')"
          :aria-label="t('common.new')"
          @click="gridRef?.openCreate()"
        />
        <div
          id="dataview-compact-actions"
          class="flex items-center gap-2"
        />
        <!-- A CUSTOM page's header widgets (CustomPage.vue's Teleport). -->
        <div
          v-if="isCustom"
          id="custom-page-header"
          class="flex items-center gap-2"
        />
      </PageHeader>
    </template>

    <UEmpty
      v-if="error"
      icon="i-lucide-lock"
      :title="t('dataviews.grid.notAvailable')"
      :description="t('dataviews.grid.notAvailableHelp')"
    />

    <template v-else>
      <UEmpty
        v-if="pending || fieldsPending"
        loading
        variant="naked"
        size="sm"
      />

      <div
        v-else-if="isCustom"
        :class="customContentClass"
      >
        <CustomPage
          :key="`${dataview!.id}-${dataview!.liveVersion}`"
          :dataview="dataview!"
          :fields="fields ?? []"
          :params="route.query"
          header-target="#custom-page-header"
          :footer-target="hasPageFooter ? '#custom-page-footer' : undefined"
          @close="router.back()"
        />
      </div>

      <DataViewSettingsView
        v-else-if="isSettings && dataview!.sourceResourceSchema && dataview!.sourceResourceName"
        :key="`${dataview!.id}-${dataview!.liveVersion}`"
        :dataview-slug="dataview!.slug"
        :schema="dataview!.sourceResourceSchema"
        :resource-name="dataview!.sourceResourceName"
        :resource-kind="dataview!.sourceResourceType === 'VIEW' ? 'view' : 'table'"
        :primary-key="primaryKey ?? null"
        :layout="resolveSettingsLayout(dataview!.viewConfig)"
        :searchable="features.search !== false"
      />

      <DataViewExternalFrame
        v-else-if="isFrame"
        ref="frameRef"
        :url="frameUrl"
        :title="dataview!.name"
      />

      <!-- The grid reads the viewer's saved state and its first rows before it
      draws (its setup awaits both): a loading state meanwhile, not a blank body. -->
      <!-- A list (TABLE, CARDS, KANBAN, CALENDAR, GANTT, MAP): its margin is the DataView's, else the instance's
      (list_margin - normal by default; none puts it right under the header). data-shell="list" and data-dataview-type are stable
      anchors for custom CSS (Admin_UI.md §4.1.1). -->
      <div
        v-else-if="gridReady"
        data-shell="list"
        :data-dataview-type="activeLayout ?? dataview!.viewType"
        class="flex min-h-0 flex-1 flex-col"
        :class="listMarginClass"
      >
        <Suspense>
          <DataViewGrid
            ref="gridRef"
            class="min-h-0 flex-1"
            layout="standalone"
            :edge-to-edge="listMargin === 'none'"
            :view-type="dataview!.viewType"
            :layouts="resolveLayouts(dataview!)"
            :card-layout="cardLayout"
            :map-layout="mapLayout"
            :map-view="mapView"
            :kanban-layout="kanbanLayout"
            :calendar-layout="calendarLayout"
            :gantt-layout="ganttLayout"
            :tree-layout="treeLayout"
            :dataview-id="dataview!.id"
            :dataview-slug="dataview!.slug"
            :shared-view="typeof route.query.view === 'string' ? route.query.view : undefined"
            :link-filter="typeof route.query.filter === 'string' ? route.query.filter : undefined"
            :schema="dataview!.sourceResourceSchema!"
            :resource-name="dataview!.sourceResourceName!"
            :fields="fields ?? []"
            :dataview-title="dataview!.name ?? ''"
            :dataview-description="dataview!.description ?? ''"
            :dataview="dataview"
            :can-write="canWrite"
            :can-create="canCreate"
            :can-delete="canDelete"
            :primary-key="primaryKey"
            :features="features"
            :edit-presentation="editPresentation"
            :edit-size="editSize"
            :edit-side="editSide"
            :forced-where="baseWhere"
            :source-resource-oid="dataview!.sourceResourceOid ?? undefined"
            :source-resource-type="dataview!.sourceResourceType ?? undefined"
            :source-resource-id="dataview!.sourceResource"
            :show-refresh="features.refresh !== false"
            :refresh-interval="autoRefresh"
            :default-state="defaultState"
            compact-search-target="#dataview-compact-search"
            compact-actions-target="#dataview-compact-actions"
            @layout-change="(type: string) => { activeLayout = type }"
            @shared-view-applied="dropSharedView"
            @link-filter-applied="dropLinkFilter"
          />
          <template #fallback>
            <UEmpty
              loading
              variant="naked"
              size="sm"
            />
          </template>
        </Suspense>
      </div>
    </template>
    <template
      v-if="hasPageFooter"
      #footer
    >
      <div
        id="custom-page-footer"
        :class="customContentClass"
      />
    </template>
  </PageShell>
</template>
