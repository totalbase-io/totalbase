<script setup lang="ts">
/**
 * Settings > PostgreSQL > Backups (Administration.md §12): the backups.*
 * settings, then the backups - queued, running, completed or failed -, 20 a
 * page, newest first.
 * Back up now queues one for the worker; the list is polled only while one
 * is queued or running. A completed backup downloads through a link the
 * server signs for a minute (an archive may be too large to pass through
 * the page) and is deleted with its archive. Restore… hands the commands that
 * restore it (BackupRestoreWizard.vue) - nothing runs from here. Its switch turns backups off as a
 * whole: the settings below it wait for it (its `primary` switch), the list
 * never does - what was made stays to download or delete.
 */
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import type { Backup, BackupsOverview } from '~/types/backup'
import { formatBytes } from '~/utils/format-bytes'

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const ui = useUiLocale()

const PAGE_SIZE = 20
const page = ref(1)
const { data, pending, refresh } = await useAsyncData('backups-list', async () => {
  const { data: backups, meta } = await api.get<Backup[]>('/backups', { page: page.value, limit: PAGE_SIZE })
  return { backups, overview: meta as unknown as BackupsOverview & { total: number } }
}, { watch: [page] })
const backups = computed(() => data.value?.backups ?? [])
const overview = computed(() => data.value?.overview ?? null)
const total = computed(() => data.value?.overview.total ?? 0)
const active = computed(() => backups.value.some(b => b.status === 'PENDING' || b.status === 'RUNNING'))

// Polled while one is under way, and once more when it ends.
let poll: ReturnType<typeof setTimeout> | undefined
watch(active, (isActive) => {
  if (poll) clearTimeout(poll)
  const tick = () => {
    poll = setTimeout(async () => {
      await refresh()
      if (active.value) tick()
    }, 3000)
  }
  if (isActive) tick()
}, { immediate: true })
onBeforeUnmount(() => poll && clearTimeout(poll))

const dateTime = computed(() => new Intl.DateTimeFormat(ui.intlLocale.value, { dateStyle: 'medium', timeStyle: 'short' }))
const when = (value: string) => dateTime.value.format(new Date(value))

const queuing = ref(false)
async function backUpNow() {
  queuing.value = true
  try {
    await api.post('/backups')
    toast.add({ title: t('settings.backups.queued'), color: 'success' })
    // The new one is first: back to the first page.
    page.value = 1
    await refresh()
  } catch (err) {
    notifyError(err, t('settings.backups.queueFailed'))
  } finally {
    queuing.value = false
  }
}

async function download(backup: Backup) {
  try {
    const { data: link } = await api.post<{ url: string }>(`/backups/${backup.id}/download`)
    window.location.assign(link.url)
  } catch (err) {
    notifyError(err, t('settings.backups.downloadFailed'))
  }
}

const deleting = ref<Backup | null>(null)
const deleteOpen = ref(false)
const deleteBusy = ref(false)
function askDelete(backup: Backup) {
  deleting.value = backup
  deleteOpen.value = true
}
async function confirmDelete() {
  if (!deleting.value) return
  deleteBusy.value = true
  try {
    await api.del(`/backups/${deleting.value.id}`)
    deleteOpen.value = false
    await refresh()
  } catch (err) {
    notifyError(err, t('settings.backups.deleteFailed'))
  } finally {
    deleteBusy.value = false
  }
}

const restoring = ref<Backup | null>(null)
const restoreOpen = ref(false)
/** Where local archives are, inside the container - the saved backups.local_path. */
const localPath = ref('/var/lib/totalbase/backups')
async function askRestore(backup: Backup) {
  try {
    localPath.value = (await api.get<Record<string, unknown>>('/settings/backups')).data['backups.local_path'] as string || localPath.value
  } catch {
    // The default path stands.
  }
  restoring.value = backup
  restoreOpen.value = true
}

const STATUS_COLOR = { PENDING: 'neutral', RUNNING: 'info', COMPLETED: 'success', FAILED: 'error' } as const
function rowMenu(backup: Backup): DropdownMenuItem[] {
  const underWay = backup.status === 'PENDING' || backup.status === 'RUNNING'
  return [
    { label: t('common.download'), icon: 'i-lucide-download', disabled: backup.status !== 'COMPLETED', onSelect: () => void download(backup) },
    { label: t('settings.backups.restore.menu'), icon: 'i-lucide-archive-restore', disabled: backup.status !== 'COMPLETED' || !backup.manifest, onSelect: () => void askRestore(backup) },
    { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', disabled: underWay, onSelect: () => askDelete(backup) }
  ]
}
const columns = computed<TableColumn<Backup>[]>(() => [
  { id: 'backup', header: t('settings.backups.columns.backup') },
  { id: 'status', header: t('settings.backups.columns.status') },
  { id: 'size', header: t('settings.backups.columns.size'), meta: { class: { th: 'text-right', td: 'text-right' } } },
  { id: 'actions', meta: { class: { th: 'w-10', td: 'w-10' } } }
])
</script>

<template>
  <SettingsGroupForm
    group="backups"
    :cron-timezone="overview?.timezone"
    @saved="() => refresh()"
  >
    <template #actions="{ off }">
      <UButton
        icon="i-lucide-archive"
        :label="t('settings.backups.backUpNow')"
        :loading="queuing"
        :disabled="active || off || !overview?.enabled"
        @click="backUpNow"
      />
    </template>
    <template #after>
      <section class="mt-6 flex flex-col gap-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
          {{ t('settings.backups.listTitle') }}
        </h3>
        <p class="text-sm text-muted">
          <template v-if="overview?.enabled && overview.nextAt">
            {{ t('settings.backups.nextAt', { when: when(overview.nextAt), timezone: overview.timezone }) }}
          </template>
          <template v-else>
            {{ t('settings.backups.scheduleOff') }}
          </template>
        </p>
        <UTable
          sticky
          :data="backups"
          :columns="columns"
          :loading="pending && !data"
        >
          <template #backup-cell="{ row }">
            <div class="flex flex-col">
              <span>{{ when(row.original.createdAt) }}</span>
              <span class="text-xs text-muted">
                {{ row.original.trigger === 'SCHEDULED' ? t('settings.backups.scheduled') : t('settings.backups.manual') }} · {{ row.original.destination === 'S3' ? t('settings.backups.s3') : t('settings.backups.local') }}
              </span>
              <span
                v-if="row.original.error"
                class="text-xs text-error whitespace-normal"
              >{{ row.original.error }}</span>
            </div>
          </template>
          <template #status-cell="{ row }">
            <UBadge
              :color="STATUS_COLOR[row.original.status]"
              variant="subtle"
              :label="t(`settings.backups.status.${row.original.status}`)"
            />
          </template>
          <template #size-cell="{ row }">
            {{ row.original.sizeBytes === null ? '' : formatBytes(row.original.sizeBytes) }}
          </template>
          <template #actions-cell="{ row }">
            <UDropdownMenu
              :items="rowMenu(row.original)"
              :content="{ align: 'end' }"
            >
              <UButton
                icon="i-lucide-ellipsis-vertical"
                color="neutral"
                variant="ghost"
                size="sm"
                :aria-label="t('common.actions')"
              />
            </UDropdownMenu>
          </template>
          <template #empty>
            <UEmpty
              variant="naked"
              size="sm"
              icon="i-lucide-archive"
              :title="t('settings.backups.empty')"
              :description="t('settings.backups.emptyDescription')"
            />
          </template>
        </UTable>
        <TablePager
          v-if="total > PAGE_SIZE"
          v-model:page="page"
          :page-size="PAGE_SIZE"
          :total="total"
          :noun="t('settings.backups.pager.noun')"
          :plural="t('settings.backups.pager.plural')"
          hide-page-size
        />
        <p class="text-xs text-muted">
          {{ t('settings.backups.masterKeyApart') }}
        </p>
      </section>
      <BackupRestoreWizard
        v-model:open="restoreOpen"
        :backup="restoring"
        :local-path="localPath"
        @download="download"
      />
      <DataViewGridDeleteModal
        v-model:open="deleteOpen"
        :title="t('settings.backups.deleteTitle')"
        :body="t('settings.backups.deleteBody', { name: deleting?.name ?? '' })"
        :loading="deleteBusy"
        require-confirm
        @confirm="confirmDelete"
      />
    </template>
  </SettingsGroupForm>
</template>
