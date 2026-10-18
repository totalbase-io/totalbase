<script setup lang="ts">
/**
 * The Design form as its own page (Specification_DataViews.md §12.1)
 * - reached from the DataView settings page's header action
 * "Design". A page rather than the drawer it used to be: it only loads when
 * opened (GridStack and the whole designer stay out of the settings
 * page), a reload stays here, and `?field=<id>` / `?tab=variables|code`
 * bring the same field's inspector / tab back. The designer's tabs sit in
 * this header's center.
 *
 * This header reports Saving/Saved and whether the draft has unpublished
 * changes, and publishes - its own Publish (confirmed, as the settings
 * page's) or the Preview drawer's (DataViewPreviewDrawer.vue): either way
 * every pending designer edit is written first, so what goes out is what's
 * on screen.
 */
import CustomDesigner from '~/components/CustomDesigner.vue'
import { DATAVIEW_TYPE_META, DESIGNER_VIEWS, type DataView, type DataViewField, type DataViewPublish, type DesignerView } from '~/types/dataview'

const route = useRoute()
const router = useRouter()
const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
/** The designer's tabs, in the UI's language. */
const catalogText = useCatalogText()
const designerViews = computed(() => DESIGNER_VIEWS.map(v => ({ ...v, label: catalogText(`dataviews.meta.designerViews.${v.value}`, v.label) })))

const id = computed(() => String(route.params.id))
// Both fetched straight by id, in parallel - not through useDataViewById,
// whose fields fetch is keyed on the loaded DataView and can briefly report
// `[]` for it; the designer seeds its working copy once, on mount, so it
// must never mount against a not-yet-loaded field list.
const { data: dataview, error, refresh: refreshDataview } = useAsyncData(
  () => `dataview-design-${id.value}`,
  () => api.get<DataView>(`/dataviews/${id.value}`).then(r => r.data),
  { watch: [id] }
)
const { data: fields, error: fieldsError } = useAsyncData(
  () => `dataview-design-fields-${id.value}`,
  () => api.get<DataViewField[]>(`/dataviews/${id.value}/fields`).then(r => r.data),
  { watch: [id] }
)
const loadError = computed(() => error.value ?? fieldsError.value)

const { data: status, refresh: refreshStatus } = useAsyncData(
  () => `dataview-design-status-${id.value}`,
  () => api.get<DataView>(`/dataviews/${id.value}`).then(r => ({ liveVersion: r.data.liveVersion ?? null, hasUnpublishedChanges: r.data.hasUnpublishedChanges ?? true })),
  { watch: [id] }
)
// The DataViews sidebar colors each entry by this same status.
watch(status, (value) => {
  if (value) useAppsNavDataViews().patchStatus(id.value, value)
})

// A page - CUSTOM, or a record form made of widgets - has its own designer (widgets, variables, code); same page contract.
const customRef = ref<InstanceType<typeof CustomDesigner> | null>(null)
const isCustom = computed(() => dataview.value !== null && dataview.value !== undefined && dataview.value.viewType !== 'EXTERNALFRAME')
const activeDesigner = computed(() => customRef.value)

// --- Preview (DataViewPreviewDrawer.vue): the whole DataView from the
// draft, live data, read-only - every pending designer edit written first.
// Its Publish runs this page's publish (the same endpoint and refreshes
// as the settings page's).
const toast = useToast()
const draftPreviewOpen = ref(false)
const draftPreviewMounted = useOpenedOnce(draftPreviewOpen)
async function openDraftPreview() {
  await activeDesigner.value?.flush()
  await refreshStatus()
  draftPreviewOpen.value = true
}
const publishing = ref(false)
/** The one publish path of this page - its header's Publish and the Preview drawer's. Every pending edit written first. True once published. */
async function publish(note?: string): Promise<boolean> {
  publishing.value = true
  try {
    await activeDesigner.value?.flush()
    const { data, meta } = await api.post<DataViewPublish>(`/dataviews/${id.value}/publish`, note ? { data: { note } } : undefined)
    await Promise.all([refreshStatus(), useAppsNavDataViews().refresh()])
    toast.add({ title: t('designer.designPage.published', { version: data.version }), color: 'success' })
    for (const warning of (meta?.warnings as string[] | undefined) ?? []) toast.add({ title: t('designer.publishWarning'), description: warning, color: 'warning' })
    return true
  } catch (err) {
    notifyError(err, t('designer.designPage.publishError'))
    return false
  } finally {
    publishing.value = false
  }
}
/** Settings, every pending designer edit written first. */
async function openSettings() {
  await activeDesigner.value?.flush()
  await router.push(`/dataviews/${id.value}/settings`)
}
async function publishFromPreview() {
  if (await publish()) draftPreviewOpen.value = false
}
const saveStatus = computed(() => activeDesigner.value?.saveStatus ?? 'idle')
/** Something to publish: the draft differs from the live version - or an edit is still being written. */
const canPublish = computed(() => (status.value?.hasUnpublishedChanges ?? true) || saveStatus.value === 'saving')
// A landed write is exactly when "unpublished changes" can flip on.
watch(saveStatus, (value) => {
  if (value === 'saved') refreshStatus()
})

/** Read once - the designer's initial selection and tab; the tabs are this header's (a phone: above the body - PageHeader hides its center there). */
const initialFieldId = typeof route.query.field === 'string' ? route.query.field : null
const view = ref<DesignerView>(DESIGNER_VIEWS.find(v => v.value === route.query.tab)?.value ?? 'design')
const isMobile = useIsMobile()
// One source for both query params - two back-to-back `router.replace`
// calls (e.g. Events' Add selects nothing new but switches to Code) would
// each spread a `route.query` the other hasn't updated yet.
const urlState = reactive<{ field: string | null, tab: DesignerView }>({ field: initialFieldId, tab: view.value })
watch(view, (tab) => {
  urlState.tab = tab
})
watch(urlState, ({ field, tab }) => {
  const { field: _field, tab: _tab, ...rest } = route.query
  router.replace({ query: { ...rest, ...(field ? { field } : {}), ...(tab !== 'design' ? { tab } : {}) } })
})

// Leaving: commit any pending inspector edit and wait for in-flight writes,
// so the page we land on (usually settings) reads the saved state.
onBeforeRouteLeave(async () => {
  await activeDesigner.value?.flush().catch(() => {})
})
// Reload/close can't be awaited - ask for confirmation only while something is actually unsaved.
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (activeDesigner.value?.hasUnsavedWork()) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
</script>

<template>
  <PageShell :scroll="false">
    <template
      v-if="!loadError"
      #header
    >
      <PageHeader
        :title="dataview?.name ?? t('designer.designPage.title')"
        :description="dataview?.sourceResourceSchema ? t('designer.designPage.descriptionWithSource', { source: `${dataview.sourceResourceSchema}.${dataview.sourceResourceName}` }) : t('designer.designPage.title')"
        :icon="dataview ? DATAVIEW_TYPE_META[dataview.viewType].icon : 'i-lucide-layout-dashboard'"
        height="editor"
        :actions="[{ label: t('common.preview'), icon: 'i-lucide-eye', tooltip: t('designer.designPage.previewTooltip'), onSelect: () => { void openDraftPreview() } }]"
      >
        <template
          v-if="isCustom"
          #center
        >
          <UTabs
            v-model="view"
            :items="designerViews"
            :content="false"
            variant="link"
            size="sm"
          />
        </template>
        <template #status>
          <SaveStatus
            :status="saveStatus"
            :retryable="false"
          />
        </template>
        <!-- The other screen (Specification_Admin_UI.md §3.7). -->
        <UButton
          icon="i-lucide-settings"
          :label="t('common.settings')"
          color="neutral"
          variant="outline"
          @click="openSettings"
        />
        <UnpublishedChangesBadge v-if="status?.hasUnpublishedChanges" />
        <DiagnosisBadge
          :key="`diagnosis-${(status?.liveVersion ?? 0)}`"
          kind="dataview"
          :object-id="id"
        />
        <PublishButton
          :diagnosis="{ kind: 'dataview', objectId: id }"
          :loading="publishing"
          :disabled="!canPublish"
          :next-version="(status?.liveVersion ?? 0) + 1"
          :note="t('designer.designPage.publishConfirmDescription')"
          @publish="publish"
        />
      </PageHeader>
    </template>
    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      :title="loadError.message"
    />

    <template v-else>
      <!-- Gated on the data being there, not on `pending` - a later refetch must never unmount the designer mid-edit. -->
      <UEmpty
        v-if="!dataview || !fields"
        loading
        variant="naked"
        size="sm"
      />

      <div
        v-else-if="isCustom"
        class="flex min-h-0 flex-1 flex-col gap-3"
      >
        <UTabs
          v-if="isMobile"
          v-model="view"
          :items="designerViews"
          :content="false"
          variant="link"
          size="sm"
          class="shrink-0"
        />
        <CustomDesigner
          ref="customRef"
          v-model:view="view"
          v-model:selected-field="urlState.field"
          :dataview="dataview"
          :fields="fields"
          class="min-h-0 flex-1"
          @presentation-saved="refreshDataview(); refreshStatus()"
          @open-saved="refreshStatus()"
        />
      </div>

      <UAlert
        v-else
        color="warning"
        variant="subtle"
        :title="t('designer.designPage.externalFrame')"
      />
    </template>
    <DataViewPreviewDrawer
      v-if="draftPreviewMounted"
      v-model:open="draftPreviewOpen"
      :dataview-id="id"
      :has-unpublished-changes="status?.hasUnpublishedChanges ?? true"
      :live-version="status?.liveVersion ?? null"
      :publishing="publishing"
      @publish="publishFromPreview"
    />
  </PageShell>
</template>
