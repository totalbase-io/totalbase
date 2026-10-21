import type { Ref } from 'vue'
import type { DraftNode } from '~/utils/workflow-tree-context'

export interface DraftConnection { source: string, target: string, output: string }
export interface WorkflowDefinition { operations: DraftNode[], connections: DraftConnection[] }
/** The draft as `GET /workflows/:id/draft` answers it - the workflow's row and the definition being edited. */
export interface WorkflowDraft {
  workflow: { id: string, name: string, description: string | null, slug: string, revision: string, historyEnabled: boolean, historyLevel: 'SUMMARY' | 'DETAILED', enabled: boolean, consecutiveFailures: number, publishedVersion: string | null, liveVersion: number | null, hasUnpublishedChanges: boolean }
  definition: WorkflowDefinition
}
export interface WorkflowVersionRecord { id: string, version: number, restoredFromVersion: number | null, user: string | null, publishedAt: string, note: string | null }

/**
 * A workflow's versions in its editor (Foundations.md §13, shared with
 * Dashboards and DataViews): the list (newest first; the first is the live
 * one), and selecting one puts the canvas in read-only preview mode -
 * `displayedDefinition` is what every read site renders from, so the same
 * tree code draws either the live draft or a frozen historical snapshot
 * without knowing the difference. Only the editor's write paths care which
 * one is active, and they all guard on `previewVersion` being non-null to
 * refuse while previewing.
 *
 * Also what acts on a previewed version: Restore (that version replaces the
 * draft - nothing is published, what runs stays the live version), Save as
 * (a new, disabled, unpublished workflow from it) and Delete old versions.
 *
 * Async: it awaits the versions read, like the page's own `useAsyncData`s.
 */
export async function useWorkflowVersions(options: {
  workflowId: () => string
  draft: Ref<WorkflowDraft | null | undefined>
  /** Rereads the draft (its workflow row changes on a restore). */
  refresh: () => Promise<unknown>
  /** The open step modal - closed when a version is previewed. */
  activeNodeId: Ref<string | null>
}) {
  const api = useAdminApi()
  const toast = useToast()
  const { t } = useI18n()
  const notifyError = useErrorToast()

  const previewVersion = ref<WorkflowVersionRecord | null>(null)
  const previewDefinition = ref<WorkflowDefinition | null>(null)
  const previewLoading = ref(false)
  const displayedDefinition = computed<WorkflowDefinition | undefined>(() => previewVersion.value ? previewDefinition.value ?? undefined : options.draft.value?.definition)

  // Versions - newest first; the first is the live one (MAX(version)). Awaited at the end: every other composable
  // here needs the component's context, which only the code before this function's first `await` has.
  const versionsRead = useAsyncData(`workflow-versions-${options.workflowId()}`, () => api.get<WorkflowVersionRecord[]>(`/workflows/${options.workflowId()}/versions`).then(r => r.data), { default: (): WorkflowVersionRecord[] => [] })
  const { data: versions, refresh: refreshVersions } = versionsRead
  const liveVersion = computed(() => versions.value?.[0] ?? null)

  async function selectVersion(version: number | null) {
    if (version === null) {
      backToCurrentDraft()
      return
    }
    previewLoading.value = true
    options.activeNodeId.value = null
    try {
      const { data } = await api.get<WorkflowVersionRecord & { definition: WorkflowDefinition }>(`/workflows/${options.workflowId()}/versions/${version}`)
      previewVersion.value = data
      previewDefinition.value = data.definition
    } catch (error) {
      notifyError(error, t('workflows.editor.loadVersionFailed'))
    } finally {
      previewLoading.value = false
    }
  }
  function backToCurrentDraft() {
    previewVersion.value = null
    previewDefinition.value = null
  }
  // Restore (Foundations.md §13.4): that version replaces the draft - nothing is published,
  // what runs stays the live version. VersionPreviewBanner confirms first
  // when there are unpublished (or unsaved) changes, which this replaces.
  const restoring = ref(false)
  async function restore() {
    if (!previewVersion.value || !options.draft.value) return
    const version = previewVersion.value.version
    restoring.value = true
    try {
      await api.post(`/workflows/${options.workflowId()}/versions/${version}/restore`, { data: { revision: options.draft.value.workflow.revision } })
      backToCurrentDraft()
      await Promise.all([options.refresh(), refreshVersions()])
      toast.add({ title: t('workflows.editor.restored', { version }), description: t('workflows.editor.restoredDescription'), color: 'success' })
    } catch (error) {
      notifyError(error, t('workflows.editor.restoreFailed'))
    } finally {
      restoring.value = false
    }
  }
  // Save as (Foundations.md §13.4): a new, disabled, unpublished workflow from that version.
  const saveAsOpen = ref(false)
  const savingAs = ref(false)
  async function saveAs(input: { name: string, slug: string }) {
    if (!previewVersion.value) return
    savingAs.value = true
    try {
      const { data } = await api.post<WorkflowDraft['workflow']>(`/workflows/${options.workflowId()}/versions/${previewVersion.value.version}/duplicate`, { data: input })
      saveAsOpen.value = false
      await refreshNuxtData('workflows-tree')
      toast.add({ title: t('workflows.editor.copyCreated', { name: data.name }), description: t('workflows.editor.copyCreatedDescription'), color: 'success' })
      await navigateTo(`/workflows/${data.id}`)
    } catch (error) {
      notifyError(error, t('workflows.editor.copyFailed'))
    } finally {
      savingAs.value = false
    }
  }
  // "Delete old versions…" (Foundations.md §13.4): a preview of a deleted version goes back to the draft.
  const deleteVersionsOpen = ref(false)
  function openDeleteVersions() {
    deleteVersionsOpen.value = true
  }
  async function onVersionsDeleted(deleted: number[]) {
    const viewing = previewVersion.value?.version
    if (viewing !== undefined && deleted.includes(viewing)) await selectVersion(null)
    await refreshVersions()
  }
  const { mobileMenu: versionsMobileMenu } = useVersionMenu(() => versions.value ?? [], () => previewVersion.value?.version ?? null, selectVersion, openDeleteVersions)

  await versionsRead
  return {
    previewVersion,
    previewLoading,
    displayedDefinition,
    versions,
    refreshVersions,
    liveVersion,
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
