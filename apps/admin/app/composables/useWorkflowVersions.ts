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
 * A workflow's versions in its editor (useObjectVersions, shared with Dashboards and DataViews): selecting one puts
 * the canvas in read-only preview mode - `displayedDefinition` is what every read site renders from, so the same
 * tree code draws either the live draft or a frozen historical snapshot without knowing the difference. Only the
 * editor's write paths care which one is active, and they all guard on `previewVersion` being non-null to refuse
 * while previewing. Restore sends the draft's revision; Save as makes a new, disabled, unpublished workflow.
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
  const versioning = useObjectVersions<WorkflowVersionRecord, WorkflowVersionRecord & { definition: WorkflowDefinition }>({
    path: () => `/workflows/${options.workflowId()}`,
    key: () => `workflow-versions-${options.workflowId()}`,
    onSelect: () => {
      options.activeNodeId.value = null
    },
    restoreBody: () => ({ revision: options.draft.value?.workflow.revision }),
    afterRestore: options.refresh,
    afterCopy: () => refreshNuxtData('workflows-tree'),
    copyUrl: copy => `/workflows/${copy.id}`
  })
  const displayedDefinition = computed<WorkflowDefinition | undefined>(() => versioning.preview.value ? versioning.preview.value.definition : options.draft.value?.definition)
  // Newest first; the first is the live one (MAX(version)).
  const liveVersion = computed(() => versioning.versions.value?.[0] ?? null)

  await versioning.read
  return { ...versioning, previewVersion: versioning.preview, displayedDefinition, liveVersion }
}
