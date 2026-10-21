<script setup lang="ts">
/**
 * An object's Versions section (Foundations.md §13.7, Admin_UI.md §3.7): its history as a timeline,
 * newest first - the draft on top while it differs from the live version, then every version with who published it,
 * when, its note, and Active / restored-from badges. A version opens read-only (`open`), restores into the draft
 * (confirmed, never published) or becomes a new object (Save as) from its row's "⋮"; Delete old versions at the
 * heading. One row per version, so a long history still reads at a glance. The same component for a DataView, a
 * Dashboard and a Workflow - the host passes the pillar and what its restore needs.
 */
import type { VersionSummary } from '~/types/versioning'

const props = defineProps<{
  pillar: 'dataviews' | 'dashboards' | 'workflows'
  objectId: string
  objectName: string
  versions: VersionSummary[]
  hasUnpublishedChanges: boolean
  publishing?: boolean
  /** The pillar's own words on what Publish makes live (PublishButton's note). */
  publishNote: string
  /** What a restore must send - a workflow's revision. */
  restoreBody?: () => Record<string, unknown>
  /** Run before a restore - the host flushes its pending edits, so they don't overwrite the restored draft. */
  beforeRestore?: () => Promise<void>
}>()
const emit = defineEmits<{ open: [version: number], publish: [note: string | undefined], restored: [version: number], deleted: [versions: number[]] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const dates = useDateTimeFormat()
const directory = useUserDirectory()

const live = computed(() => props.versions[0]?.version ?? 0)
watch(() => props.versions, versions => void directory.ensure(versions.map(v => v.user)), { immediate: true })

interface Item { value: string, version: VersionSummary | null }
const items = computed<Item[]>(() => [
  ...(props.hasUnpublishedChanges || props.versions.length === 0 ? [{ value: 'draft', version: null }] : []),
  ...props.versions.map(version => ({ value: `v${version.version}`, version }))
])
const publisher = (version: VersionSummary) => ({
  name: version.user ? directory.label(version.user, t('shell.versions.unknownUser')) : t('shell.versions.unknownUser'),
  avatar: { src: directory.avatar(version.user) ?? undefined, alt: version.user ? directory.label(version.user) : undefined },
  description: dates.dateTime(version.publishedAt, { dateStyle: 'medium', timeStyle: 'short' })
})

// --- Restore (Foundations.md §13.4): the draft replaced, nothing published; confirmed in a popover. ---
const restoring = ref<number | null>(null)
const restoreVersion = ref<number | null>(null)
async function confirmRestore() {
  const version = restoreVersion.value
  if (version === null) return
  await restore(version)
  restoreVersion.value = null
}
async function restore(version: number) {
  restoring.value = version
  try {
    await props.beforeRestore?.()
    await api.post(`/${props.pillar}/${props.objectId}/versions/${version}/restore`, props.restoreBody ? { data: props.restoreBody() } : undefined)
    toast.add({ title: t('shell.versions.restored', { version }), description: t('shell.versions.restoredDescription'), color: 'success' })
    emit('restored', version)
  } catch (error) {
    notifyError(error, t('shell.versions.restoreError'))
  } finally {
    restoring.value = null
  }
}

// --- Save as: a new, unpublished object from that version. ---
const saveAsVersion = ref<number | null>(null)
const savingAs = ref(false)
async function saveAs(input: { name: string, slug: string }) {
  if (saveAsVersion.value === null) return
  savingAs.value = true
  try {
    const { data } = await api.post<{ id: string, name: string }>(`/${props.pillar}/${props.objectId}/versions/${saveAsVersion.value}/duplicate`, { data: input })
    saveAsVersion.value = null
    toast.add({ title: t('shell.versions.copyCreated', { name: data.name }), description: t('shell.versions.copyCreatedDescription'), color: 'success' })
    if (props.pillar === 'dataviews') await useAppsNavDataViews().refresh()
    else if (props.pillar === 'dashboards') await useAppsNavDashboards().refresh()
    else await refreshNuxtData('workflows-tree')
    await navigateTo(props.pillar === 'dataviews' ? `/dataviews/${data.id}/settings` : `/${props.pillar}/${data.id}`)
  } catch (error) {
    notifyError(error, t('shell.versions.copyError'))
  } finally {
    savingAs.value = false
  }
}

const deleteOpen = ref(false)
</script>

<template>
  <SettingsSection :title="t('common.versions')">
    <template
      v-if="versions.length > 1"
      #actions
    >
      <UButton
        :label="t('shell.versions.deleteOld')"
        icon="i-lucide-trash-2"
        color="neutral"
        variant="outline"
        size="sm"
        @click="deleteOpen = true"
      />
    </template>

    <UTimeline
      :items="items"
      size="xs"
      :ui="{ item: 'pb-4', wrapper: 'min-w-0 flex-1', title: 'min-w-0', description: 'hidden' }"
    >
      <!-- One row per hito: what it is on the left, who and when and the actions on the right. -->
      <template #title="{ item }">
        <div
          v-if="!item.version"
          class="flex min-w-0 items-center gap-3"
        >
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-semibold text-highlighted">{{ t('common.draft') }}</span>
            <span class="text-sm text-muted">{{ hasUnpublishedChanges ? t('shell.versions.draftHint') : t('shell.versions.noVersions') }}</span>
          </div>
          <PublishButton
            :loading="publishing"
            :disabled="!hasUnpublishedChanges"
            :next-version="live + 1"
            :note="publishNote"
            @publish="(note: string | undefined) => emit('publish', note)"
          />
        </div>
        <div
          v-else
          class="flex min-w-0 items-center gap-3"
        >
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-semibold text-highlighted">{{ `v${item.version.version}` }}</span>
            <UBadge
              v-if="item.version.version === live"
              :label="t('common.active')"
              color="success"
              variant="subtle"
              size="sm"
            />
            <span
              v-if="item.version.note"
              class="truncate text-sm text-default"
            >{{ item.version.note }}</span>
            <span
              v-if="item.version.restoredFromVersion"
              class="text-sm text-muted"
            >{{ t('shell.versions.restoredFrom', { version: item.version.restoredFromVersion }) }}</span>
          </div>
          <UUser
            v-bind="publisher(item.version)"
            size="xs"
            class="shrink-0 max-md:hidden"
          />
          <UDropdownMenu
            :items="[[
              { label: t('shell.versions.open'), icon: 'i-lucide-eye', onSelect: () => emit('open', item.version!.version) },
              { label: t('shell.versions.saveAs'), icon: 'i-lucide-copy', onSelect: () => { saveAsVersion = item.version!.version } }
            ], [
              { label: t('shell.versions.restore'), icon: 'i-lucide-undo-2', onSelect: () => { restoreVersion = item.version!.version } }
            ]]"
            :content="{ align: 'end' }"
          >
            <UButton
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="xs"
              :loading="restoring === item.version.version"
              :aria-label="t('common.actions')"
            />
          </UDropdownMenu>
        </div>
      </template>
    </UTimeline>

    <!-- Restore, confirmed (AGENTS.md §25): the draft is replaced, nothing goes live. -->
    <UModal
      :open="restoreVersion !== null"
      :title="t('shell.versions.restoreConfirm', { version: restoreVersion ?? 0 })"
      :description="t('shell.versions.restoreDescription', { version: restoreVersion ?? 0 })"
      @update:open="(value: boolean) => { if (!value) restoreVersion = null }"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="restoreVersion = null"
          />
          <UButton
            :label="t('shell.versions.restore')"
            color="warning"
            :loading="restoring !== null"
            @click="confirmRestore"
          />
        </div>
      </template>
    </UModal>

    <VersionSaveAsModal
      :open="saveAsVersion !== null"
      :source-label="`${objectName} v${saveAsVersion ?? ''}`"
      :loading="savingAs"
      @update:open="(value: boolean) => { if (!value) saveAsVersion = null }"
      @submit="saveAs"
    />
    <DeleteVersionsModal
      v-model:open="deleteOpen"
      :pillar="pillar"
      :object-id="objectId"
      :versions="versions"
      @deleted="(deleted: number[]) => emit('deleted', deleted)"
    />
  </SettingsSection>
</template>
