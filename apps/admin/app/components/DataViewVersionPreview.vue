<script setup lang="ts">
/**
 * A DataView rendered as users see it - over today's live data, with
 * writes off - from a given configuration: a version's snapshot (the
 * editor's version preview, Foundations.md §13.7) or the
 * current draft (DataViewPreviewDrawer.vue - see it before publishing).
 * FORM layouts reuse DataViewRecordPage with that configuration; every
 * grid-like layout reuses DataViewGrid.
 *
 * Records open the way the DataView is configured - Drawer, Modal or
 * Sidebar, read-only. A PAGE is its own App route, which would leave the
 * preview for the published version: it opens as the widest Modal
 * instead, with a note saying how the App opens it.
 */
import CustomPage from '~/components/CustomPage.vue'
import { FORM_LIKE_DATAVIEW_TYPES, resolveFrameUrl, type DataView, type DataViewField } from '~/types/dataview'
import { DATAVIEW_READONLY_PREVIEW_KEY } from '~/utils/dataview-preview'

const props = defineProps<{
  dataview: DataView
  fields: DataViewField[]
  /** Remounts the layout when it changes (another version opened). */
  renderKey?: string | number
  /** A CUSTOM page's header widgets go there - the host's page header (CustomPage.vue). */
  headerTarget?: string
  /** A CUSTOM page's footer widgets go there - the host's pinned footer (CustomPage.vue). */
  footerTarget?: string
}>()

// Whatever opens from inside stays read-only too (a Detail's rows, another DataView's records).
provide(DATAVIEW_READONLY_PREVIEW_KEY, true)
const { t } = useI18n()

const dataview = computed(() => props.dataview)
const fields = computed(() => props.fields)
const { primaryKey, features, editPresentation: configuredPresentation, editSize, editSide, baseWhere, defaultState, cardLayout, mapLayout, mapView, kanbanLayout, calendarLayout, ganttLayout, treeLayout } = useDataViewPresentation(dataview, fields, { readOnly: true })
const opensAsPage = computed(() => configuredPresentation.value === 'PAGE')
const editPresentation = computed(() => opensAsPage.value ? 'MODAL' : configuredPresentation.value)
const recordEditSize = computed(() => opensAsPage.value ? 'xl' : editSize.value)
const gridReady = computed(() => !!(dataview.value.sourceResourceSchema && dataview.value.sourceResourceName))
</script>

<template>
  <DataViewRecordPage
    v-if="FORM_LIKE_DATAVIEW_TYPES.includes(dataview.viewType)"
    :key="renderKey"
    class="p-4"
    :dataview="dataview"
    :fields="fields"
    preview
  />
  <!-- CUSTOM: the page runs for real - its Calls ask first (they write). -->
  <CustomPage
    v-else-if="dataview.viewType === 'CUSTOM'"
    :key="renderKey"
    class="p-4"
    :dataview="dataview"
    :fields="fields"
    :header-target="headerTarget"
    :footer-target="footerTarget"
    preview
  />
  <DataViewExternalFrame
    v-else-if="dataview.viewType === 'EXTERNALFRAME'"
    :key="renderKey"
    :url="resolveFrameUrl(dataview.viewConfig)"
    :title="dataview.name"
  />
  <DataViewGrid
    v-else-if="gridReady"
    :key="renderKey"
    class="min-h-0 flex-1"
    layout="embedded"
    :view-type="dataview.viewType"
    :card-layout="cardLayout"
    :map-layout="mapLayout"
    :map-view="mapView"
    :kanban-layout="kanbanLayout"
    :calendar-layout="calendarLayout"
    :gantt-layout="ganttLayout"
    :tree-layout="treeLayout"
    :dataview-id="dataview.id"
    :dataview-slug="dataview.slug"
    :schema="dataview.sourceResourceSchema!"
    :resource-name="dataview.sourceResourceName!"
    :fields="fields"
    :dataview-title="dataview.name"
    :dataview-description="dataview.description ?? ''"
    :dataview="dataview"
    :can-write="false"
    :primary-key="primaryKey"
    :features="features"
    :edit-presentation="editPresentation"
    :edit-size="recordEditSize"
    :record-form-note="opensAsPage ? t('designer.dataViewVersionPreview.opensAsPage') : undefined"
    :edit-side="editSide"
    :forced-where="baseWhere"
    :source-resource-oid="dataview.sourceResourceOid ?? undefined"
    :source-resource-type="dataview.sourceResourceType ?? undefined"
    :source-resource-id="dataview.sourceResource"
    :show-refresh="true"
    :default-state="defaultState"
  />
  <p
    v-else
    class="py-12 text-center text-sm text-muted"
  >
    {{ t('designer.dataViewVersionPreview.noPreview') }}
  </p>
</template>
