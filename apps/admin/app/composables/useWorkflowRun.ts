import type { ComputedRef, Ref } from 'vue'
import { manualRunBlocker } from '~/utils/workflow-runs'
import type { WorkflowDefinition, WorkflowDraft } from '~/composables/useWorkflowVersions'

/**
 * Test run / Run in the workflow editor (Workflows.md §11) -
 * one modal, its mode set by the action. Test run runs the saved draft, so
 * any pending autosave is flushed first (a failed save stops the run and says
 * so in the modal). Run runs the live version: a MANUAL or CRON trigger,
 * published and enabled - the action is disabled with the reason otherwise.
 */
export function useWorkflowRun(options: {
  workflowId: () => string
  draft: Ref<WorkflowDraft | null | undefined>
  /** Saved-but-unpublished or edited-but-not-saved: the live definition differs from the draft's. */
  hasUnpublishedChanges: ComputedRef<boolean>
  /** Flushes the pending autosave - a Test run runs the saved draft. */
  flushDraft: () => Promise<void>
  /** The Logs panel, landing on a run (a Test run's / Run's result). */
  openLogs: (runId: string) => void
}) {
  const api = useAdminApi()
  const { t } = useI18n()

  const runModalOpen = ref(false)
  const runModalMode = ref<'TEST' | 'PRODUCTION'>('TEST')
  function openRunModal(mode: 'TEST' | 'PRODUCTION') {
    runModalMode.value = mode
    runModalOpen.value = true
  }
  // The live version's definition: the draft itself while nothing differs
  // from it, read once per published version otherwise - it says whether the
  // live trigger can be run on demand and names a production run's steps.
  const liveDefinitionRead = ref<{ version: number, definition: WorkflowDefinition } | null>(null)
  watch(() => [options.draft.value?.workflow.liveVersion ?? null, options.hasUnpublishedChanges.value] as const, async ([version, differs]) => {
    if (!version || !differs || liveDefinitionRead.value?.version === version) return
    try {
      const { data } = await api.get<{ definition: WorkflowDefinition }>(`/workflows/${options.workflowId()}/versions/${version}`)
      liveDefinitionRead.value = { version, definition: data.definition }
    } catch {
      // Unknown live trigger: Run stays disabled until it can be read.
    }
  }, { immediate: true })
  const liveDefinition = computed<WorkflowDefinition | undefined>(() => {
    const version = options.draft.value?.workflow.liveVersion
    if (!version) return undefined
    if (!options.hasUnpublishedChanges.value) return options.draft.value?.definition
    return liveDefinitionRead.value?.version === version ? liveDefinitionRead.value.definition : undefined
  })
  const manualRunBlocked = computed(() => {
    const workflow = options.draft.value?.workflow
    if (!workflow) return t('common.loading')
    const liveStart = liveDefinition.value?.operations.find(o => o.type === 'totalbase.start')
    return manualRunBlocker(workflow, liveStart?.configuration?.trigger as string | undefined, t)
  })
  function operationNames(definition: WorkflowDefinition | undefined) {
    return (definition?.operations ?? []).map(o => ({ id: o.id, key: o.key, label: o.type === 'totalbase.start' ? t('workflows.editor.start') : o.label }))
  }
  // A CRON live version runs on demand exactly as its schedule would (Workflows.md §11.2): no input.
  const liveRunScheduled = computed(() => liveDefinition.value?.operations.find(o => o.type === 'totalbase.start')?.configuration?.trigger === 'CRON')
  const runModalOperations = computed(() => operationNames(runModalMode.value === 'TEST' ? options.draft.value?.definition : liveDefinition.value))
  const draftOperationNames = computed(() => operationNames(options.draft.value?.definition))
  function openRunInLogs(runId: string) {
    runModalOpen.value = false
    options.openLogs(runId)
  }

  return { runModalOpen, runModalMode, openRunModal, manualRunBlocked, liveRunScheduled, runModalOperations, draftOperationNames, flushDraft: options.flushDraft, openRunInLogs }
}
