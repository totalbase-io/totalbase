<script setup lang="ts">
import WorkflowTree from '~/components/workflows/WorkflowTree.vue'
import type { Component } from 'vue'
import ConditionModal, { type ConditionConfiguration } from '~/components/workflows/ConditionModal.vue'
import ForEachModal, { type ForEachConfiguration } from '~/components/workflows/ForEachModal.vue'
import SelectCaseModal, { type SelectCaseConfiguration } from '~/components/workflows/SelectCaseModal.vue'
import ReadRecordsModal, { type ReadRecordsConfiguration } from '~/components/workflows/ReadRecordsModal.vue'
import CreateRecordsModal, { type CreateRecordsConfiguration } from '~/components/workflows/CreateRecordsModal.vue'
import UpdateRecordsModal, { type UpdateRecordsConfiguration } from '~/components/workflows/UpdateRecordsModal.vue'
import DeleteRecordsModal, { type DeleteRecordsConfiguration } from '~/components/workflows/DeleteRecordsModal.vue'
import ExecuteFunctionModal, { type ExecuteFunctionConfiguration } from '~/components/workflows/ExecuteFunctionModal.vue'
import ExecuteJavascriptModal, { type ExecuteJavascriptConfiguration } from '~/components/workflows/ExecuteJavascriptModal.vue'
import ExecuteSqlModal, { type ExecuteSqlConfiguration } from '~/components/workflows/ExecuteSqlModal.vue'
import HttpRequestModal, { type HttpRequestConfiguration } from '~/components/workflows/HttpRequestModal.vue'
import SoapRequestModal, { type SoapRequestConfiguration } from '~/components/workflows/SoapRequestModal.vue'
import SignModal, { type SignConfiguration } from '~/components/workflows/SignModal.vue'
import SendEmailModal, { type SendEmailConfiguration } from '~/components/workflows/SendEmailModal.vue'
import ReadFileModal, { type ReadFileConfiguration } from '~/components/workflows/ReadFileModal.vue'
import CreateFileModal, { type CreateFileConfiguration } from '~/components/workflows/CreateFileModal.vue'
import ParseFileModal, { type ParseFileConfiguration } from '~/components/workflows/ParseFileModal.vue'
import GenerateFileModal, { type GenerateFileConfiguration } from '~/components/workflows/GenerateFileModal.vue'
import GeneratePdfTemplateModal, { type GeneratePdfTemplateConfiguration } from '~/components/workflows/GeneratePdfTemplateModal.vue'
import GeneratePdfModal, { type GeneratePdfConfiguration } from '~/components/workflows/GeneratePdfModal.vue'
import ExecuteWorkflowModal, { type ExecuteWorkflowConfiguration } from '~/components/workflows/ExecuteWorkflowModal.vue'
import WorkflowRunModal from '~/components/workflows/WorkflowRunModal.vue'
import WaitResumeModal, { type WaitResumeConfiguration } from '~/components/workflows/WaitResumeModal.vue'
import ProcessBatchesModal, { type ProcessBatchesConfiguration } from '~/components/workflows/ProcessBatchesModal.vue'
import ValidateDataModal, { type ValidateDataConfiguration } from '~/components/workflows/ValidateDataModal.vue'
import FinishErrorModal, { type FinishErrorConfiguration } from '~/components/workflows/FinishErrorModal.vue'
import FinishResultModal, { type FinishResultConfiguration } from '~/components/workflows/FinishResultModal.vue'
import { operationDefinition, type OperationType } from '@totalbase/tb-catalog'
import { useOperationCatalogText } from '~/utils/workflow-operations'
import { useTriggerOptions } from '~/utils/workflow-triggers'
import { configurationLimitProblem, definitionLimitProblem, WORKFLOW_DEFINITION_LIMITS } from '~/utils/workflow-limits'
import type { DraftNode as TreeDraftNode, WorkflowTreeContext } from '~/utils/workflow-tree-context'
import { hasErrorOutput, STEP_NODE_META, stepSubtitle, type StepSubtitleContext } from '~/utils/workflow-step-subtitles'
import type { WorkflowDefinition, WorkflowDraft } from '~/composables/useWorkflowVersions'
import WorkflowCanvas from '~/components/workflows/WorkflowCanvas.vue'
import WorkflowDisabledBadge from '~/components/workflows/WorkflowDisabledBadge.vue'

const route = useRoute()
const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const { operationTitle } = useOperationCatalogText()
const triggerOptions = useTriggerOptions()
const publishing = ref(false)
// Which node's own config modal is open - one id shared by every
// configurable operation type (see onNodeClick/activeNode below) rather
// than a separate "open id" ref per type, now that there's more than one.
const activeNodeId = ref<string | null>(null)

type DraftNode = TreeDraftNode
type Draft = WorkflowDraft
// `deep: true` - Nuxt 4 defaults useAsyncData to a shallow ref, so in-place
// edits below (operations.splice/push, reassigning .connections) would
// otherwise never trigger a re-render; only a full refresh()-driven `.value`
// swap is tracked by a shallow ref. Delete relies on exactly that in-place
// mutation - the autosave watch below picks it up like any other edit.
// The definition as last saved - the canvas is edited in place and
// autosaved (useAutosave below), so "unsaved" = differs from this.
const savedDefinitionJson = ref('')
const { data: draft, refresh } = await useAsyncData(
  `workflow-draft-${route.params.id}`,
  () => api.get<Draft>(`/workflows/${route.params.id}/draft`).then((r) => {
    savedDefinitionJson.value = JSON.stringify(r.data.definition)
    return r.data
  }),
  { deep: true }
)
const hasUnsavedChanges = computed(() => Boolean(draft.value) && JSON.stringify(draft.value!.definition) !== savedDefinitionJson.value)
// The Workflows sidebar badges each entry by the server's status - written
// into its cached list, so it follows without a refetch. That list is
// useAsyncData's shallowRef: a new array is assigned, since mutating an
// entry in place would never re-render the sidebar.
const workflowsTree = useNuxtData<{ id: string, name?: string, description?: string | null, slug?: string, liveVersion?: number | null, hasUnpublishedChanges?: boolean }[]>('workflows-tree')
watch(() => draft.value && {
  id: draft.value.workflow.id,
  name: draft.value.workflow.name,
  description: draft.value.workflow.description,
  slug: draft.value.workflow.slug,
  liveVersion: draft.value.workflow.liveVersion,
  hasUnpublishedChanges: draft.value.workflow.hasUnpublishedChanges
}, (status) => {
  const list = workflowsTree.data.value
  if (!status || !list) return
  const entry = list.find(w => w.id === status.id)
  if (!entry || (Object.keys(status) as (keyof typeof status)[]).every(key => entry[key] === status[key])) return
  workflowsTree.data.value = list.map(w => w.id === status.id ? { ...w, ...status } : w)
}, { immediate: true })

// Versions (useWorkflowVersions - Specification.md §13, shared with Dashboards and DataViews): selecting a version
// puts the canvas in read-only preview mode - `displayedDefinition` is what every read site (startNode,
// operationById, connectionTarget, etc.) renders from. Only the write paths (addStep, removeOperation, save,
// onTriggerSave, onOperationSave) care which one is active, and they all guard on `previewVersion` being non-null
// to refuse while previewing (WorkflowTreeContext's own `readOnly` additionally hides the controls that would call
// them in the first place).
const { previewVersion, displayedDefinition, versions, refreshVersions, liveVersion, selectVersion, restoring, restore, saveAsOpen, savingAs, saveAs, deleteVersionsOpen, onVersionsDeleted, versionsMobileMenu } = await useWorkflowVersions({
  workflowId: () => String(route.params.id),
  draft,
  refresh,
  activeNodeId
})

// Settings › Versions opens a version here: `?version=N` previews it.
onMounted(() => {
  const asked = Number(route.query.version)
  if (asked) void selectVersion(asked)
})

// Every operation type renders through WorkflowStepCard.vue's card look -
// icon, title, subtitle, color. The step menu offers the operation catalog's
// (@totalbase/tb-catalog) operations; a type it doesn't have can't be added.
const startNode = computed(() => displayedDefinition.value?.operations.find(node => node.type === 'totalbase.start'))
const activeNode = computed(() => displayedDefinition.value?.operations.find(node => node.id === activeNodeId.value))
/**
 * Each step type's configuration modal - the one of the active node is the only one mounted (below).
 * Keyed by the catalog's types, so an operation added to the catalog without its modal fails the typecheck.
 */
const STEP_MODALS: Record<Exclude<OperationType, 'totalbase.start'>, Component> = {
  'totalbase.condition': ConditionModal,
  'totalbase.for-each': ForEachModal,
  'totalbase.select-case': SelectCaseModal,
  'totalbase.read-records': ReadRecordsModal,
  'totalbase.create-records': CreateRecordsModal,
  'totalbase.update-records': UpdateRecordsModal,
  'totalbase.delete-records': DeleteRecordsModal,
  'totalbase.execute-function': ExecuteFunctionModal,
  'totalbase.execute-javascript': ExecuteJavascriptModal,
  'totalbase.execute-sql': ExecuteSqlModal,
  'totalbase.http-request': HttpRequestModal,
  'totalbase.soap-request': SoapRequestModal,
  'totalbase.sign': SignModal,
  'totalbase.send-email': SendEmailModal,
  'totalbase.read-file': ReadFileModal,
  'totalbase.create-file': CreateFileModal,
  'totalbase.parse-file': ParseFileModal,
  'totalbase.generate-file': GenerateFileModal,
  'totalbase.generate-pdf-template': GeneratePdfTemplateModal,
  'totalbase.generate-pdf': GeneratePdfModal,
  'totalbase.execute-workflow': ExecuteWorkflowModal,
  'totalbase.wait-resume': WaitResumeModal,
  'totalbase.process-batches': ProcessBatchesModal,
  'totalbase.validate-data': ValidateDataModal,
  'totalbase.finish-error': FinishErrorModal,
  'totalbase.finish-result': FinishResultModal
}
const stepModal = (type: string): Component | undefined => (STEP_MODALS as Record<string, Component | undefined>)[type]
/** True a tick after a node becomes active: the modal mounts closed, then opens - its `open` watcher is what seeds it. */
const activeModalOpen = ref(false)
watch(activeNode, async (node) => {
  activeModalOpen.value = false
  if (!node) return
  await nextTick()
  if (activeNode.value === node) activeModalOpen.value = true
})
function operationById(id: string) {
  return displayedDefinition.value?.operations.find(node => node.id === id)
}

// The shared registry (useResourcesList) - the step modals' pickers read the same one.
const { resources: tables } = useResourcesList()
const tableName = (id: unknown) => tables.value.find(table => table.id === id)?.name ?? String(id)

/**
 * Each step's card look (WorkflowStepCard.vue): STEP_NODE_META's kind and color, the catalog's icon, the node's own label, and
 * its subtitle from its configuration (workflow-step-subtitles.ts). Start has its own look.
 */
const subtitleContext: StepSubtitleContext = { t, tableName, triggerTitle: trigger => triggerOptions.value.find(option => option.value === trigger)?.title }
function nodeView(node: TreeDraftNode) {
  const draftNode = node as DraftNode
  const subtitle = stepSubtitle(draftNode.type, draftNode.configuration, subtitleContext)
  if (draftNode.type === 'totalbase.start') return { kind: 'start' as const, icon: 'i-lucide-play', title: t('workflows.editor.start'), subtitle, color: 'primary' as const }
  const meta = (STEP_NODE_META as Record<string, (typeof STEP_NODE_META)[keyof typeof STEP_NODE_META] | undefined>)[draftNode.type]
  const icon = operationDefinition(draftNode.type)?.icon
  if (meta && icon) return { kind: meta.kind, icon, title: draftNode.label || meta.kind, subtitle, color: meta.color, hasError: hasErrorOutput(draftNode.type) }
  return { kind: 'action' as const, icon: 'i-lucide-box', title: draftNode.label, subtitle: '', color: 'neutral' as const }
}

function connectionTarget(source: string, output: string): string | undefined {
  return displayedDefinition.value?.connections.find(c => c.source === source && c.output === output)?.target
}

function onNodeClick(node: TreeDraftNode) {
  if (previewVersion.value) return
  if (node.type === 'totalbase.start') openSettings('trigger')
  else activeNodeId.value = node.id
}

// A node is only deletable once every output it owns is still an empty
// slot - deleting one with a wired child would silently orphan that whole
// downstream chain instead of just this one node.
function canDelete(id: string): boolean {
  return !displayedDefinition.value?.connections.some(c => c.source === id)
}

function otherKeys(id: string): string[] {
  return (displayedDefinition.value?.operations ?? []).filter(o => o.id !== id).map(o => o.key)
}

// A fresh, unique default key for a newly-added node - `read_records`,
// `read_records_2`, ... - derived from its own type so it reads as
// something meaningful before the user ever renames it. Never collides
// with "start" (reserved for the trigger) since that's not a `type`-derived
// base any real operation type produces.
function defaultStepKey(type: string): string {
  const base = type.replace(/^totalbase\./, '').replace(/-/g, '_')
  const taken = new Set(draft.value?.definition.operations.map(o => o.key) ?? [])
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

// Inline "+" picker replaces the old palette-drag/canvas-drop flow: adding
// a step now always happens in the context of one specific (source,
// output) slot, so the new connection is unambiguous - no auto-assigning
// the "first free rotation slot" the way drag-to-connect had to.
// A new step's own `parent` (Specification_Workflows.md §3.4's body ownership, generalized to
// every loop-shaped operation - engine.ts's `runLoopOperation()`): a loop
// node's own body-entry output ("Item" for For each, "Batch" for Process
// in batches) starts a brand new body scope owned by that node; every
// other output (including that same node's "Done"/"error") just continues
// whatever scope its source was already in - root for a root-scope
// source, the same loop node's id for a body-scope source.
function scopeForNewStep(source: DraftNode | undefined, output: string): string | undefined {
  const bodyOutput = source ? operationDefinition(source.type)?.bodyOutput : undefined
  if (bodyOutput) return output === bodyOutput ? source!.id : source!.parent
  return source?.parent
}

// Specification_Workflows.md §3.6: the editor refuses what the server would.
const operationLimitReached = computed(() => (draft.value?.definition.operations.length ?? 0) >= WORKFLOW_DEFINITION_LIMITS.maxOperations)
function addStep(source: string, output: string, type: string) {
  if (previewVersion.value || !draft.value || operationLimitReached.value) return
  const item = operationDefinition(type)
  if (!item?.group) return
  const id = crypto.randomUUID()
  const parent = scopeForNewStep(operationById(source), output)
  draft.value.definition.operations.push({ id, type: item.type, label: operationTitle(item.type, item.label), key: defaultStepKey(item.type), configuration: {}, ...(parent && { parent }) })
  draft.value.definition.connections.push({ source, target: id, output })
  activeNodeId.value = id
}

// Removes the operation itself plus any connection touching it (as
// either end) - an edge left pointing at a deleted node, or hanging off
// one as its source, would be a dangling reference the next save() would
// happily persist. The node menu only offers this when canDelete(id) is
// true, but connections.filter below is defensive either way.
function removeOperation(id: string) {
  if (previewVersion.value || !draft.value) return
  const { operations, connections } = draft.value.definition
  const index = operations.findIndex(o => o.id === id)
  if (index === -1) return
  operations.splice(index, 1)
  draft.value.definition.connections = connections.filter(c => c.source !== id && c.target !== id)
  if (activeNodeId.value === id) activeNodeId.value = null
}

// Every node reachable from `id` by following its outgoing connections
// (any output, recursively) - a plain BFS over `connections`, not the tree
// shape itself, so it works the same whether the fan-out is a Condition's
// true/false or a plain node's error branch. `visited` guards against a
// connection loop ever turning this into an infinite walk, even though the
// cardinality rule (Specification_Workflows.md §3.4) shouldn't allow one to exist.
function descendants(id: string): string[] {
  const connections = displayedDefinition.value?.connections ?? []
  const visited = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const c of connections) {
      if (c.source === current && !visited.has(c.target)) {
        visited.add(c.target)
        queue.push(c.target)
      }
    }
  }
  return [...visited]
}
function descendantCount(id: string): number {
  return descendants(id).length
}
// The confirmed-cascade counterpart to removeOperation - drops `id` and
// every node it reaches, plus every connection touching any of them.
function removeOperationCascade(id: string) {
  if (previewVersion.value || !draft.value) return
  const toRemove = new Set([id, ...descendants(id)])
  draft.value.definition.operations = draft.value.definition.operations.filter(o => !toRemove.has(o.id))
  draft.value.definition.connections = draft.value.definition.connections.filter(c => !toRemove.has(c.source) && !toRemove.has(c.target))
  if (activeNodeId.value && toRemove.has(activeNodeId.value)) activeNodeId.value = null
}

provide<WorkflowTreeContext>('workflow-tree', {
  get readOnly() { return previewVersion.value !== null },
  get operationLimitReached() { return operationLimitReached.value },
  operationById,
  nodeView,
  connectionTarget,
  onNodeClick,
  addStep,
  removeOperation,
  removeOperationCascade,
  canDelete,
  descendantCount,
  otherKeys
})

// Autosave (useAutosave.ts): every canvas edit goes into the draft after a
// short pause - Publish is the one deliberate step. The response carries the
// new `revision`; the definition itself is NOT re-read (that would clobber
// an edit made while the save was in flight).
async function save() {
  if (previewVersion.value || !draft.value) return
  const definition = JSON.parse(JSON.stringify(draft.value.definition)) as WorkflowDefinition
  const sentJson = JSON.stringify(definition)
  if (sentJson === savedDefinitionJson.value) return
  const limitProblem = definitionLimitProblem(definition, t)
  if (limitProblem) {
    toast.add({ title: t('workflows.editor.saveFailed'), description: limitProblem, color: 'error' })
    throw new Error(limitProblem)
  }
  try {
    const { data } = await api.put<Draft>(`/workflows/${route.params.id}/draft`, { data: { revision: draft.value.workflow.revision, definition } })
    draft.value.workflow = data.workflow
    savedDefinitionJson.value = sentJson
  } catch (error) {
    notifyError(error, t('workflows.editor.saveFailed'))
    throw error
  }
}
const autosave = useAutosave(save)
watch(() => draft.value ? JSON.stringify(draft.value.definition) : '', (json) => {
  if (!previewVersion.value && json && json !== savedDefinitionJson.value)autosave.schedule()
})

// Same delete WorkflowsTree.vue's own row-level ConfirmDeletePopover
// already does - kept here too (not just the sidebar) since a user deep
// in the editor shouldn't have to go back to the list to find it. Its own
// runs/steps/versions cascade-delete via FK (verified live this round);
// records it created in the developer's own tables (e.g. a create-records
// step's rows) are NOT touched - a workflow's write is indistinguishable
// from any other write once committed, deleting the automation doesn't
// undo its past effects.
const deleting = ref(false)
async function deleteWorkflow() {
  deleting.value = true
  try {
    await api.del(`/workflows/${route.params.id}`)
    deleteOpen.value = false
    await refreshNuxtData('workflows-tree')
    await navigateTo('/workflows')
  } catch (error) {
    notifyError(error, t('workflows.editor.deleteFailed'))
  } finally {
    deleting.value = false
  }
}

// "Publish" first flushes any pending autosave (so it never ships a
// stale draft), then publishes that exact revision.
async function publish(note?: string) {
  if (previewVersion.value || !draft.value) return
  publishing.value = true
  try {
    await autosave.flush()
    if (!draft.value) return
    const previous = draft.value.workflow.liveVersion
    const { data } = await api.post<{ liveVersion: number | null }>(`/workflows/${route.params.id}/publish`, { data: { revision: draft.value.workflow.revision, ...(note && { note }) } })
    await refresh()
    await refreshVersions()
    // A draft equal to the live version publishes nothing - the server answers it as is (Specification.md §13.4).
    toast.add(data.liveVersion === previous
      ? { title: t('workflows.editor.nothingToPublish'), description: t('workflows.editor.alreadyLive', { version: previous }), color: 'neutral' }
      : { title: t('workflows.editor.published'), color: 'success' })
  } catch (error) {
    notifyError(error, t('workflows.editor.publishFailed'))
  } finally {
    publishing.value = false
  }
}

// Enabled or not is set in Settings › General (§16.6); here the header only says when it is not.

// Saved-but-unpublished (server, Specification.md §13.5) OR edited-but-not-even-saved (client).
const hasUnpublishedChanges = computed(() => Boolean(draft.value?.workflow.hasUnpublishedChanges) || hasUnsavedChanges.value)
// "Called by" badge (workflowsAdmin.listCallers()'s own doc comment) -
// other workflows with an execute-workflow step targeting this one.
// Fetched once on load, same "small, rarely-changing list" assumption
// every other admin list in this codebase already makes.
interface WorkflowCallerRecord { id: string, name: string, slug: string, live: boolean, draftPending: boolean }
const { data: callers } = await useAsyncData(`workflow-called-by-${route.params.id}`, () => api.get<WorkflowCallerRecord[]>(`/workflows/${route.params.id}/called-by`).then(r => r.data), { default: (): WorkflowCallerRecord[] => [] })

// Object actions - the "⋮" menu next to the title (same header layout as
// the Dashboards editor): Settings… and Delete…, kept apart from the
// everyday actions on the right.
/** The settings page (§16.6), at one of its sections - a pending autosave is flushed first. */
async function openSettings(section?: 'trigger' | 'runs', run?: string) {
  await autosave.flush()
  await navigateTo({ path: `/workflows/${route.params.id}/settings`, query: { ...(section && { section }), ...(run && { run }) } })
}
const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
watch(deleteOpen, (isOpen) => {
  if (isOpen) deleteConfirmed.value = false
})
const objectMenuItems = computed(() => [
  [{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { deleteOpen.value = true } }]
])

// Header secondary actions - buttons on desktop, PageHeader's "⋮" on a
// phone, where the versions chip moves too (versionsMobileMenu).
const headerActions = computed<HeaderAction[]>(() => {
  const actions: HeaderAction[] = []
  if (callers.value?.length) {
    actions.push({
      label: t('workflows.editor.calledBy', { n: callers.value.length }),
      icon: 'i-lucide-git-branch',
      children: callers.value.map(c => ({ label: c.name, description: c.live ? t('workflows.editor.callerLive') : t('workflows.editor.callerDraftOnly'), onSelect: () => navigateTo(`/workflows/${c.id}`) }))
    })
  }
  // One Run with its two modes (Specification_Workflows.md §16.2): the draft as a test, or the live version.
  if (!previewVersion.value) {
    actions.push({
      label: t('workflows.editor.run'),
      icon: 'i-lucide-play',
      children: [
        { label: t('workflows.editor.runTest'), description: t('workflows.editor.runTestDescription'), icon: 'i-lucide-flask-conical', onSelect: () => openRunModal('TEST') },
        {
          label: t('workflows.editor.runProduction'),
          description: manualRunBlocked.value ?? t('workflows.editor.runProductionDescription', { version: draft.value?.workflow.liveVersion ?? 0 }),
          icon: 'i-lucide-play',
          disabled: manualRunBlocked.value !== null,
          onSelect: () => openRunModal('PRODUCTION')
        }
      ]
    })
  }
  return actions
})
// Test run / Run (useWorkflowRun, Specification_Workflows.md §11) - one modal, its mode set by the action.
const { runModalOpen, runModalMode, openRunModal, manualRunBlocked, liveRunScheduled, runModalOperations, flushDraft, openRunInLogs } = useWorkflowRun({
  workflowId: () => String(route.params.id),
  draft,
  hasUnpublishedChanges,
  flushDraft: async () => {
    await autosave.flush()
  },
  openLogs: (runId) => {
    void openSettings('runs', runId)
  }
})

type AnyOperationConfiguration = ConditionConfiguration | ForEachConfiguration | SelectCaseConfiguration | ReadRecordsConfiguration | CreateRecordsConfiguration | UpdateRecordsConfiguration | DeleteRecordsConfiguration
  | ExecuteFunctionConfiguration | ExecuteJavascriptConfiguration | ExecuteSqlConfiguration | HttpRequestConfiguration | SoapRequestConfiguration | SignConfiguration | SendEmailConfiguration
  | ReadFileConfiguration | CreateFileConfiguration | ParseFileConfiguration | GenerateFileConfiguration
  | GeneratePdfTemplateConfiguration | GeneratePdfConfiguration | ExecuteWorkflowConfiguration | WaitResumeConfiguration | ProcessBatchesConfiguration
  | ValidateDataConfiguration | FinishErrorConfiguration | FinishResultConfiguration
// A Select case's own output set is dynamic (its configured case names,
// unlike every other node type's fixed next/true-false/item-done) - if
// the author renames/removes a case whose branch was already wired,
// that connection (and whatever it led to) is now unreachable dead
// weight rather than a graph-shaped hole any existing validation catches.
// Pruned the same way a confirmed delete-cascade already would.
function pruneOrphanedCaseBranches(node: DraftNode) {
  if (node.type !== 'totalbase.select-case' || !draft.value) return
  const config = node.configuration as SelectCaseConfiguration
  const validOutputs = new Set([...(config.cases ?? []).map(c => c.output), ...(config.hasDefault ? ['default'] : [])])
  const orphaned = draft.value.definition.connections.filter(c => c.source === node.id && c.output !== 'error' && !validOutputs.has(c.output))
  for (const conn of orphaned) removeOperationCascade(conn.target)
}

async function onOperationSave(payload: { key: string, configuration: AnyOperationConfiguration }) {
  if (previewVersion.value) return
  const node = activeNode.value
  if (!node) return
  const limitProblem = configurationLimitProblem({ key: payload.key, configuration: payload.configuration }, t)
  if (limitProblem) {
    toast.add({ title: t('workflows.editor.stepNotSaved'), description: limitProblem, color: 'error' })
    return
  }
  node.key = payload.key
  node.configuration = payload.configuration as unknown as Record<string, unknown>
  pruneOrphanedCaseBranches(node)
  await autosave.retry()
}
</script>

<template>
  <PageShell :scroll="false">
    <template #header>
      <PageHeader
        :title="draft?.workflow.name ?? t('workflows.editor.workflow')"
        :description="draft?.workflow.description ?? t('workflows.editor.visualEditor')"
        icon="i-lucide-workflow"
        height="editor"
        :actions="headerActions"
        :menu="previewVersion ? undefined : objectMenuItems"
        :mobile-menu="versionsMobileMenu"
      >
        <template #status>
          <SaveStatus
            v-if="!previewVersion"
            :status="autosave.status.value"
            @retry="autosave.retry()"
          />
        </template>
        <!-- The other screen (Specification_Admin_UI.md §3.7), then the state, versions and Publish. -->
        <UButton
          v-if="!previewVersion"
          icon="i-lucide-settings"
          :label="t('common.settings')"
          color="neutral"
          variant="outline"
          @click="openSettings()"
        />
        <WorkflowDisabledBadge
          v-if="draft"
          :workflow="draft.workflow"
        />
        <UnpublishedChangesBadge
          v-if="hasUnpublishedChanges && !previewVersion"
        />
        <VersionsMenu
          :versions="versions ?? []"
          :viewing="previewVersion?.version ?? null"
          @select="selectVersion"
          @delete-old="deleteVersionsOpen = true"
        />
        <PublishButton
          v-if="!previewVersion"
          :loading="publishing"
          :disabled="!hasUnpublishedChanges"
          :next-version="(liveVersion?.version ?? 0) + 1"
          :note="t('workflows.editor.publishDescription')"
          @publish="publish"
        />
      </PageHeader>
    </template>
    <!-- Same header layout as the Dashboards editor: object actions in the
    "⋯" menu next to the title; on the right, content (Called by, Logs,
    Save) | publishing (Enabled, Unpublished badge, versions, Publish last). -->
    <VersionPreviewBanner
      v-if="previewVersion"
      :version="previewVersion.version"
      :published-at="previewVersion.publishedAt"
      :is-live="previewVersion.version === liveVersion?.version"
      :has-unpublished-changes="hasUnpublishedChanges"
      :restoring="restoring"
      @restore="restore"
      @save-as="saveAsOpen = true"
      @back="selectVersion(null)"
    />
    <WorkflowCanvas>
      <WorkflowTree
        v-if="startNode"
        :node-id="startNode.id"
      />
    </WorkflowCanvas>
    <WorkflowRunModal
      v-if="draft"
      v-model:open="runModalOpen"
      :workflow-id="draft.workflow.id"
      :mode="runModalMode"
      :live-version="draft.workflow.liveVersion"
      :scheduled="runModalMode === 'PRODUCTION' && liveRunScheduled"
      :operations="runModalOperations"
      :start-configuration="startNode?.configuration"
      :prepare="runModalMode === 'TEST' ? flushDraft : undefined"
      @open-logs="openRunInLogs"
    />
    <UModal
      v-model:open="deleteOpen"
      :title="t('workflows.editor.deleteTitle')"
      :description="t('workflows.editor.deleteDescription')"
    >
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UCheckbox
            v-model="deleteConfirmed"
            :label="t('common.confirm')"
          />
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            />
            <UButton
              :label="t('common.delete')"
              color="error"
              :loading="deleting"
              :disabled="!deleteConfirmed"
              @click="deleteWorkflow"
            />
          </div>
        </div>
      </template>
    </UModal>
    <VersionSaveAsModal
      v-if="previewVersion && draft"
      v-model:open="saveAsOpen"
      :source-label="`${draft.workflow.name} v${previewVersion.version}`"
      :loading="savingAs"
      @submit="saveAs"
    />
    <!-- The active step's modal alone is mounted (the others' lists would otherwise load with the editor) - it mounts
         closed and opens a tick later, so its own `open` watcher seeds it; keyed by node, so another node remounts it. -->
    <component
      :is="stepModal(activeNode.type)"
      v-if="activeNode && stepModal(activeNode.type)"
      :key="activeNode.id"
      :open="activeModalOpen"
      :model-value="activeNode.configuration ?? {}"
      :node-key="activeNode.key"
      :existing-keys="otherKeys(activeNode.id)"
      @update:open="(v: boolean) => { if (!v) activeNodeId = null }"
      @save="onOperationSave"
    />
    <DeleteVersionsModal
      v-model:open="deleteVersionsOpen"
      pillar="workflows"
      :object-id="String(route.params.id)"
      :versions="versions ?? []"
      @deleted="onVersionsDeleted"
    />
  </PageShell>
</template>
