import type { WatchSource } from 'vue'
import type { VersionSummary } from '~/types/versioning'

/**
 * A versioned object's versions in its editor (Foundations.md §13) - DataViews, Dashboards and Workflows alike:
 * the list (newest first), a version previewed read-only, and what acts on it - Restore (it replaces the draft,
 * nothing is published), Save as (a new, unpublished copy from it, opened at once) and Delete old versions (a
 * preview of a deleted one goes back to the draft). The page keeps what is its own: what the canvas draws from a
 * snapshot, which status says what's live, what to re-read after a restore.
 *
 * `read` is the versions' `useAsyncData` - a page that renders only once they're in awaits it.
 */
export function useObjectVersions<Version extends VersionSummary, Snapshot extends { version: number }>(options: {
  /** The object's Admin API path - `/dashboards/<id>`. */
  path: () => string
  /** The versions list's `useAsyncData` key. */
  key: () => string
  /** What re-reads the list - the object's id, when the page can change it. */
  watch?: WatchSource[]
  /** Runs as a version opens - close what edits the draft. */
  onSelect?: () => void
  /** Before Restore writes - flush a pending autosave so it can't land on the restored draft. */
  beforeRestore?: () => Promise<unknown>
  /** Restore's body - a workflow sends its revision. */
  restoreBody?: () => unknown
  /** After a restore - re-read the draft and its status (the list is re-read here). */
  afterRestore: () => Promise<unknown>
  /** Save as's created copy - refresh the sidebar, then the copy's editor URL. */
  afterCopy: (copy: { id: string, name: string }) => Promise<unknown>
  copyUrl: (copy: { id: string, name: string }) => string
}) {
  const api = useAdminApi()
  const toast = useToast()
  const { t } = useI18n()
  const notifyError = useErrorToast()

  const read = useAsyncData(options.key, () => api.get<Version[]>(`${options.path()}/versions`).then(r => r.data), {
    watch: options.watch,
    default: (): Version[] => []
  })
  const { data: versions, refresh: refreshVersions } = read

  const preview = ref<Snapshot | null>(null) as Ref<Snapshot | null>
  const previewLoading = ref(false)
  async function selectVersion(version: number | null) {
    if (version === null) {
      preview.value = null
      return
    }
    previewLoading.value = true
    options.onSelect?.()
    try {
      const { data } = await api.get<Snapshot>(`${options.path()}/versions/${version}`)
      preview.value = data
    } catch (error) {
      notifyError(error, t('shell.versions.loadFailed'))
    } finally {
      previewLoading.value = false
    }
  }

  // VersionPreviewBanner confirms first when there are unpublished changes, which this replaces.
  const restoring = ref(false)
  async function restore() {
    if (!preview.value) return
    const version = preview.value.version
    restoring.value = true
    try {
      await options.beforeRestore?.()
      const body = options.restoreBody?.()
      await api.post(`${options.path()}/versions/${version}/restore`, body === undefined ? undefined : { data: body })
      preview.value = null
      await Promise.all([options.afterRestore(), refreshVersions()])
      toast.add({ title: t('shell.versions.restored', { version }), description: t('shell.versions.restoredDescription'), color: 'success' })
    } catch (error) {
      notifyError(error, t('shell.versions.restoreError'))
    } finally {
      restoring.value = false
    }
  }

  const saveAsOpen = ref(false)
  const savingAs = ref(false)
  async function saveAs(input: { name: string, slug: string }) {
    if (!preview.value) return
    savingAs.value = true
    try {
      const { data } = await api.post<{ id: string, name: string }>(`${options.path()}/versions/${preview.value.version}/duplicate`, { data: input })
      saveAsOpen.value = false
      await options.afterCopy(data)
      toast.add({ title: t('shell.versions.copyCreated', { name: data.name }), description: t('shell.versions.copyCreatedDescription'), color: 'success' })
      await navigateTo(options.copyUrl(data))
    } catch (error) {
      notifyError(error, t('shell.versions.copyError'))
    } finally {
      savingAs.value = false
    }
  }

  const deleteVersionsOpen = ref(false)
  async function onVersionsDeleted(deleted: number[]) {
    const viewing = preview.value?.version
    if (viewing !== undefined && deleted.includes(viewing)) await selectVersion(null)
    await refreshVersions()
  }
  // On a phone the versions chip moves into PageHeader's "⋮".
  const { mobileMenu: versionsMobileMenu } = useVersionMenu(() => versions.value ?? [], () => preview.value?.version ?? null, selectVersion, () => {
    deleteVersionsOpen.value = true
  })

  return {
    read,
    versions,
    refreshVersions,
    preview,
    previewLoading,
    selectVersion,
    restoring,
    restore,
    saveAsOpen,
    savingAs,
    saveAs,
    deleteVersionsOpen,
    onVersionsDeleted,
    versionsMobileMenu
  }
}
