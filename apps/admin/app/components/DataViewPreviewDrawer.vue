<script setup lang="ts">
/**
 * The whole DataView as users will see it once published - the current
 * draft's layout, fields and settings over today's live data, read-only
 * (DataViewVersionPreview.vue, the same renderer as the version history's
 * preview). A bottom UDrawer (AGENTS.md §25: heavy content that wants most
 * of the screen), opened from the DataView settings and the Design form.
 *
 * Publish sits in its header - the natural moment to publish is right after
 * checking the result. It doesn't publish by itself: it emits `publish` and
 * the host runs its own publish (flush pending saves, POST, refresh), so
 * there is one publish path, not two. Same confirmation as the editor's
 * header ("Publish as vN?").
 */
import { PAGE_FOOTER_SLOT } from '@totalbase/tb-catalog'
import { dataviewIcon, type DataView, type DataViewField } from '~/types/dataview'

const props = defineProps<{
  dataviewId: string
  hasUnpublishedChanges: boolean
  /** The live version, null when never published - "Publish as v{n+1}". */
  liveVersion: number | null
  publishing: boolean
}>()
const emit = defineEmits<{ publish: [] }>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const apiError = useApiErrorMessage()
const api = useAdminApi()

// The draft, re-read on every open - the host has just flushed its saves.
const dataview = ref<DataView | null>(null)
const fields = ref<DataViewField[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
/** A CUSTOM page with widgets in its footer: pinned under the preview, as the App pins it. */
const hasPageFooter = computed(() => dataview.value?.viewType === 'CUSTOM'
  && fields.value.some(f => f.kind === 'WIDGET' && f.parent === null && (f.config as { slot?: string }).slot === PAGE_FOOTER_SLOT))
const renderKey = ref(0)
watch(open, async (isOpen) => {
  if (!isOpen) return
  loading.value = true
  loadError.value = null
  try {
    const [view, list] = await Promise.all([
      api.get<DataView>(`/dataviews/${props.dataviewId}`),
      api.get<DataViewField[]>(`/dataviews/${props.dataviewId}/fields`)
    ])
    dataview.value = view.data
    fields.value = list.data
    renderKey.value++
  } catch (error) {
    loadError.value = apiError(error, t('designer.dataViewPreviewDrawer.loadError'))
  } finally {
    loading.value = false
  }
}, { immediate: true })

const confirmOpen = ref(false)

// --- Device (DataViews.md §12.9): Desktop renders the draft
// here; Tablet and Phone frame the real App - an iframe of the draft at that
// width, same origin and session - so its phone shell and compact form are
// the App's own, nothing simulated. ---
type Device = 'desktop' | 'tablet' | 'phone'
const DEVICES = computed(() => [
  { label: t('designer.dataViewPreviewDrawer.devices.desktop'), value: 'desktop', icon: 'i-lucide-monitor' },
  { label: t('designer.dataViewPreviewDrawer.devices.tablet'), value: 'tablet', icon: 'i-lucide-tablet' },
  { label: t('designer.dataViewPreviewDrawer.devices.phone'), value: 'phone', icon: 'i-lucide-smartphone' }
])
const DEVICE_SIZE: Record<Exclude<Device, 'desktop'>, { width: number, height: number }> = {
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 }
}
const device = ref<Device>('desktop')
const frameSrc = computed(() => (dataview.value ? `/app/dataviews/${dataview.value.slug}?draft=true` : ''))
</script>

<template>
  <AppDrawer
    v-model:open="open"
    :title="t('designer.dataViewPreviewDrawer.title', { name: dataview?.name ?? 'DataView' })"
    :description="t('designer.dataViewPreviewDrawer.description')"
    start-expanded
  >
    <template #header-actions>
      <UTabs
        v-model="device"
        :items="DEVICES"
        :content="false"
        size="xs"
        :aria-label="t('designer.dataViewPreviewDrawer.device')"
        class="max-md:hidden"
      />
      <!-- One line each, all the height of the size-sm buttons beside them. -->
      <UBadge
        :label="t('designer.dataViewPreviewDrawer.readOnlyBadge')"
        color="info"
        variant="subtle"
        icon="i-lucide-eye"
        class="h-8 whitespace-nowrap px-2.5 max-md:hidden"
      />
      <UnpublishedChangesBadge
        v-if="hasUnpublishedChanges"
        inline
      />
      <UPopover v-model:open="confirmOpen">
        <UButton
          icon="i-lucide-upload"
          :label="t('common.publish')"
          color="success"
          size="sm"
          class="h-8 whitespace-nowrap"
          :variant="hasUnpublishedChanges ? 'solid' : 'soft'"
          :disabled="!hasUnpublishedChanges"
          :loading="publishing"
        />
        <template #content>
          <div class="flex max-w-64 flex-col gap-2 p-3">
            <p class="text-sm font-medium">
              {{ t('designer.dataViewPreviewDrawer.publishAs', { version: (liveVersion ?? 0) + 1 }) }}
            </p>
            <p class="text-xs text-muted">
              {{ t('designer.dataViewPreviewDrawer.publishNote') }}
            </p>
            <div class="flex justify-end gap-2 pt-1">
              <UButton
                :label="t('common.cancel')"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="confirmOpen = false"
              />
              <UButton
                :label="t('common.publish')"
                size="xs"
                color="success"
                :loading="publishing"
                @click="confirmOpen = false; emit('publish')"
              />
            </div>
          </div>
        </template>
      </UPopover>
    </template>

    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      :title="loadError"
    />
    <UEmpty
      v-else-if="loading || !dataview"
      loading
      variant="naked"
      size="sm"
    />
    <div
      v-else-if="device !== 'desktop'"
      class="flex min-h-0 flex-1 justify-center overflow-auto bg-elevated/50 p-4"
    >
      <!-- The App itself, at the device's size: its own shell decides what a phone gets. -->
      <iframe
        :key="`${device}-${renderKey}`"
        :src="frameSrc"
        :title="t(`designer.dataViewPreviewDrawer.frameTitle.${device}`, { name: dataview.name })"
        :style="{ width: `${DEVICE_SIZE[device].width}px`, height: `${DEVICE_SIZE[device].height}px` }"
        class="shrink-0 rounded-2xl border-8 border-neutral-800 bg-default shadow-lg"
      />
    </div>
    <div
      v-else
      class="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <!-- The App page's own header (pages/app/dataviews/[slug]/index.vue,
      DataViewRecordPage.vue): the draft's icon, name and description as users
      will see them. No New - the preview is read-only. -->
      <PageHeader
        :title="dataview.name"
        :description="dataview.description ?? undefined"
        :icon="dataviewIcon(dataview)"
      >
        <!-- A CUSTOM page's header widgets, as in the App. -->
        <div
          v-if="dataview.viewType === 'CUSTOM'"
          id="custom-page-preview-header"
          class="flex items-center gap-2"
        />
      </PageHeader>
      <DataViewVersionPreview
        :dataview="dataview"
        :fields="fields"
        :render-key="renderKey"
        :header-target="dataview.viewType === 'CUSTOM' ? '#custom-page-preview-header' : undefined"
        :footer-target="hasPageFooter ? '#custom-page-preview-footer' : undefined"
      />
    </div>
    <!-- A CUSTOM page's footer widgets, pinned under it as in the App. -->
    <div
      v-if="hasPageFooter && dataview && !loading && !loadError && device === 'desktop'"
      id="custom-page-preview-footer"
      class="shrink-0 border-t border-default px-4 py-3"
    />
  </AppDrawer>
</template>
