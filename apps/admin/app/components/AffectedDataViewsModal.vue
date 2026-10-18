<script setup lang="ts">
/**
 * After a column's presentation changes (Specification_DataViews.md §15):
 * the published DataViews it reaches - their drafts inherit it
 * already, their viewers still see the version they had. Each may be
 * published now, an ordinary Publish of its draft - only one with no other
 * unpublished changes, which would go along. Every one that can be starts
 * picked; nothing is published until Publish, and closing leaves them as
 * unpublished changes.
 */
interface AffectedDataView {
  id: string
  name: string
  slug: string
  liveVersion: number
  otherChanges: boolean
}

const props = defineProps<{ dataviews: AffectedDataView[] }>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const apiError = useApiErrorMessage()
const api = useAdminApi()
const toast = useToast()

const publishable = computed(() => props.dataviews.filter(d => !d.otherChanges))
const picked = ref<Record<string, boolean>>({})
function pickAll(on: boolean) {
  picked.value = Object.fromEntries(publishable.value.map(d => [d.id, on]))
}
// On opening, and when the list arrives while it is open.
watch([open, () => props.dataviews], ([isOpen]) => {
  if (isOpen) pickAll(true)
}, { immediate: true })
const toPublish = computed(() => publishable.value.filter(d => picked.value[d.id]))
const allPicked = computed(() => toPublish.value.length === publishable.value.length)

const publishing = ref(false)
async function publish() {
  publishing.value = true
  const failed: string[] = []
  for (const dataview of toPublish.value) {
    try {
      await api.post(`/dataviews/${dataview.id}/publish`)
    } catch (err) {
      failed.push(`${dataview.name}: ${apiError(err, t('common.unknownError'))}`)
    }
  }
  publishing.value = false
  const published = toPublish.value.length - failed.length
  if (published) toast.add({ title: t('designer.affectedDataViewsModal.published', published), color: 'success' })
  if (failed.length) toast.add({ title: t('designer.affectedDataViewsModal.publishError'), description: failed.join('\n'), color: 'error' })
  else open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('designer.affectedDataViewsModal.title')"
    :description="t('designer.affectedDataViewsModal.description')"
  >
    <template #body>
      <div class="flex flex-col divide-y divide-default">
        <div
          v-for="dataview in dataviews"
          :key="dataview.id"
          class="flex items-center justify-between gap-3 py-2"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-highlighted">
              {{ dataview.name }}
            </p>
            <p class="truncate text-xs text-muted">
              {{ dataview.otherChanges ? t('designer.affectedDataViewsModal.otherChanges') : t('designer.affectedDataViewsModal.live', { version: dataview.liveVersion }) }}
            </p>
          </div>
          <UCheckbox
            v-model="picked[dataview.id]"
            :label="t('designer.affectedDataViewsModal.publishNow')"
            :disabled="dataview.otherChanges"
            class="shrink-0 whitespace-nowrap"
          />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          v-if="publishable.length > 1"
          :label="allPicked ? t('designer.affectedDataViewsModal.clearAll') : t('designer.affectedDataViewsModal.selectAll')"
          color="neutral"
          variant="link"
          @click="pickAll(!allPicked)"
        />
        <span v-else />
        <div class="flex gap-2">
          <UButton
            :label="t('designer.affectedDataViewsModal.leaveUnpublished')"
            color="neutral"
            variant="ghost"
            @click="open = false"
          />
          <UButton
            :label="t('common.publish')"
            :disabled="toPublish.length === 0"
            :loading="publishing"
            @click="publish"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
