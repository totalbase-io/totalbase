<script setup lang="ts">
/**
 * "Delete old versions…" (Specification.md §13.4), shared by the three
 * editors: pick the version to keep from, and every earlier one is deleted -
 * never the live one. Irreversible, so a modal listing what goes, with the
 * Confirm checkbox. A workflow version that still has runs is kept by the
 * server and reported.
 */
import type { VersionSummary } from '~/types/versioning'

const props = defineProps<{
  pillar: 'dataviews' | 'dashboards' | 'workflows'
  objectId: string
  versions: VersionSummary[]
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ deleted: [deleted: number[]] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

/** Newest first, as the list comes; the oldest can't be "kept from" - nothing is before it. */
const keepItems = computed(() => props.versions.slice(0, -1).map(v => ({ label: `v${v.version}`, value: v.version })))
const keepFrom = ref<number | undefined>(undefined)
const confirmed = ref(false)
watch(open, (isOpen) => {
  if (!isOpen) return
  confirmed.value = false
  // Default: keep the last five (or all but the oldest when there are fewer).
  keepFrom.value = props.versions[Math.min(4, props.versions.length - 2)]?.version
})
const doomed = computed(() => keepFrom.value === undefined ? [] : props.versions.filter(v => v.version < keepFrom.value!).map(v => v.version).sort((a, b) => a - b))
const doomedLabel = computed(() => {
  const list = doomed.value
  if (list.length === 0) return ''
  return list.length === 1 ? `v${list[0]}` : t('shell.versions.deleteOldRange', { first: list[0], last: list[list.length - 1], n: list.length })
})

const deleting = ref(false)
async function remove() {
  if (keepFrom.value === undefined) return
  deleting.value = true
  try {
    const { data } = await api.del<{ deleted: number[], kept?: { version: number, runs: number }[] }>(`/${props.pillar}/${props.objectId}/versions?before=${keepFrom.value}`)
    const kept = data.kept ?? []
    toast.add({
      title: t('shell.versions.deleted', { n: data.deleted.length }, data.deleted.length),
      description: kept.length ? t('shell.versions.keptWithRuns', { versions: kept.map(k => `v${k.version}`).join(', '), runs: kept.reduce((n, k) => n + k.runs, 0) }) : undefined,
      color: 'success'
    })
    open.value = false
    emit('deleted', data.deleted)
  } catch (err) {
    notifyError(err, t('shell.versions.deleteError'))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('shell.versions.deleteOldTitle')"
    :description="t('shell.versions.deleteOldDescription')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('shell.versions.keepFrom')"
          :description="t('shell.versions.keepFromDescription')"
        >
          <USelect
            v-model="keepFrom"
            :items="keepItems"
            class="w-40"
          />
        </UFormField>
        <p
          v-if="doomedLabel"
          class="text-sm"
        >
          {{ t('shell.versions.deletes', { versions: doomedLabel }) }}
          <template v-if="pillar === 'workflows'">
            {{ t('shell.versions.keptWithRunsNote') }}
          </template>
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between">
        <UCheckbox
          v-model="confirmed"
          :label="t('common.confirm')"
        />
        <div class="flex gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="open = false"
          />
          <UButton
            :label="t('common.delete')"
            color="error"
            :loading="deleting"
            :disabled="!confirmed || doomed.length === 0"
            @click="remove"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
