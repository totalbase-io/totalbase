<script setup lang="ts">
import WorkflowStepCard from '~/components/workflows/WorkflowStepCard.vue'
import type { WorkflowTreeContext } from '~/utils/workflow-tree-context'
import { WORKFLOW_DEFINITION_LIMITS } from '~/utils/workflow-limits'
import { operationDefinition, operationOutputs } from '@totalbase/tb-catalog'

// Recursive renderer for the workflow's tree: one instance per node,
// recursing into its own template for whatever comes next. The tree never
// stores or computes positions - each level is just "this node, then
// whatever's below it", which flexbox alone lays out top-to-bottom (see
// [id].vue's doc comment on why this replaced Vue Flow entirely).
const props = defineProps<{
  nodeId: string
  /** True when this instance is the head of its parent's error branch - tints its own card red instead of a separate "on error" label/row. Never propagated to this node's own children. */
  errorBranch?: boolean
}>()

const ctx = inject<WorkflowTreeContext>('workflow-tree')!

const node = computed(() => ctx.operationById(props.nodeId))
const view = computed(() => (node.value ? ctx.nodeView(node.value) : undefined))
const canDelete = computed(() => !ctx.readOnly && ctx.canDelete(props.nodeId))
const descendantCount = computed(() => ctx.descendantCount(props.nodeId))

// The node's ports from the operation catalog (Specification_Workflows.md §3.3):
// `next`, a Condition's `true`/`false`, a loop's body entry and `done`, a
// Select case's own case names (+ `default`), nothing for a terminal step -
// `error` is rendered separately, off to the side, never in this primary rotation.
const primaryOutputs = computed(() => {
  if (!node.value) return []
  return (operationOutputs(node.value.type, node.value.configuration) ?? ['next', 'error']).filter(output => output !== 'error')
})
const errorTarget = computed(() => (view.value?.hasError ? ctx.connectionTarget(props.nodeId, 'error') : undefined))

// `next` only reads as "Success" once there's an error output to contrast
// it with (Read records etc.) - a plain node like Start has no error path,
// so its single output stays a neutral "Add step" instead. True/false use a
// green check / amber x (not the error path's red ban) - false is a normal
// branch, not a failure.
// Labels are translated (workflows.workflowTree.outputs.<output>); a Select
// case's own case names are the author's, shown as written.
const { t } = useI18n()
const OUTPUT_META: Record<string, { icon: string, iconClass: string }> = {
  true: { icon: 'i-lucide-check', iconClass: 'text-success' },
  false: { icon: 'i-lucide-x', iconClass: 'text-warning' },
  item: { icon: 'i-lucide-repeat', iconClass: 'text-info' },
  batch: { icon: 'i-lucide-boxes', iconClass: 'text-info' },
  done: { icon: 'i-lucide-check', iconClass: 'text-success' },
  default: { icon: 'i-lucide-circle-slash', iconClass: 'text-muted' },
  error: { icon: 'i-lucide-ban', iconClass: 'text-error' }
}
function outputMeta(output: string) {
  if (output === 'next') return view.value?.hasError
    ? { label: t('workflows.workflowTree.outputs.success'), icon: 'i-lucide-check', iconClass: 'text-success' }
    : { label: t('workflows.workflowTree.outputs.addStep'), icon: 'i-lucide-plus', iconClass: 'text-muted' }
  const meta = OUTPUT_META[output]
  return meta ? { label: t(`workflows.workflowTree.outputs.${output}`), ...meta } : { label: output, icon: 'i-lucide-plus', iconClass: 'text-muted' }
}
// One node-menu entry per output this node owns - the only way to add a
// step now (see [id].vue's doc comment on why the old inline "+"/"on
// error" placeholders were dropped). Disabled once that slot is already
// wired, so the menu never offers to silently replace/orphan a child.
const addSlots = computed(() => {
  if (ctx.readOnly) return []
  const outputs = view.value?.hasError ? [...primaryOutputs.value, 'error'] : primaryOutputs.value
  const limitReached = ctx.operationLimitReached
  return outputs.map(output => ({
    output,
    disabled: limitReached || !!ctx.connectionTarget(props.nodeId, output),
    ...(limitReached && { description: t('workflows.workflowTree.limitReached', { max: WORKFLOW_DEFINITION_LIMITS.maxOperations }) }),
    ...outputMeta(output)
  }))
})

// True for the one column ("item"/"batch") that's this loop's own REPEATED
// body, as opposed to "done" (an ordinary, run-once continuation) - drives
// the visually-contained-block treatment below, so a loop's body reads as
// "everything inside this box runs once per element/batch" at a glance,
// not just another branch column indistinguishable from a Condition's
// true/false. Never true for a Condition/Select case - those are
// alternative paths, not a repeated region.
function isLoopBody(output: string): boolean {
  return node.value !== undefined && operationDefinition(node.value.type)?.bodyOutput === output
}

// The visible column set below this card - only rendered as a multi-branch
// row once there's actually more than one (a Condition's true/false, or a
// single output plus an error branch). A plain single "next" with nothing
// wired yet renders no row at all (see the template's plain v-else-if).
const branches = computed(() => {
  const cols = primaryOutputs.value
    .filter(output => primaryOutputs.value.length > 1 || ctx.connectionTarget(props.nodeId, output))
    .map(output => ({ key: output, target: ctx.connectionTarget(props.nodeId, output), label: primaryOutputs.value.length > 1 ? output : undefined, errorBranch: false, loopBody: isLoopBody(output) }))
  if (errorTarget.value) cols.push({ key: 'error', target: errorTarget.value, label: undefined, errorBranch: true, loopBody: false })
  return cols
})
</script>

<template>
  <div
    v-if="node && view"
    class="flex w-fit flex-col items-center"
  >
    <WorkflowStepCard
      :kind="view.kind"
      :icon="view.icon"
      :title="view.title"
      :subtitle="view.subtitle"
      :color="view.color"
      :can-delete="canDelete"
      :add-slots="addSlots"
      :error-tint="errorBranch"
      :descendant-count="descendantCount"
      :step-key="node.key"
      :read-only="ctx.readOnly"
      @click="ctx.onNodeClick(node!)"
      @remove="ctx.removeOperation(nodeId)"
      @remove-cascade="ctx.removeOperationCascade(nodeId)"
      @add="(output, type) => ctx.addStep(nodeId, output, type)"
    />

    <template v-if="branches.length > 1">
      <div class="h-4 w-px border-l-2 border-accented" />
      <div class="flex items-start justify-center">
        <div
          v-for="(branch, i) in branches"
          :key="branch.key"
          class="relative flex flex-col items-center px-6"
        >
          <div
            v-if="i > 0"
            class="absolute left-0 top-0 h-0.5 w-1/2 bg-accented"
          />
          <div
            v-if="i < branches.length - 1"
            class="absolute right-0 top-0 h-0.5 w-1/2 bg-accented"
          />
          <p
            v-if="branch.label"
            class="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide"
            :class="branch.label === 'true' || branch.label === 'done' ? 'text-success' : branch.loopBody ? 'text-info' : 'text-warning'"
          >
            <UIcon
              v-if="branch.loopBody"
              name="i-lucide-repeat"
              class="size-3"
            />
            {{ branch.label }}
          </p>
          <div
            class="h-4 w-px border-l-2"
            :class="branch.loopBody ? 'border-info/50' : 'border-accented'"
          />
          <div
            v-if="branch.loopBody && branch.target"
            class="rounded-lg border-2 border-dashed border-info/40 bg-info/5 px-4 pb-4 pt-3"
          >
            <WorkflowTree :node-id="branch.target" />
          </div>
          <WorkflowTree
            v-else-if="branch.target"
            :node-id="branch.target"
            :error-branch="branch.errorBranch"
          />
        </div>
      </div>
    </template>
    <template v-else-if="branches.length === 1 && branches[0]!.target">
      <div class="h-6 w-px border-l-2 border-accented" />
      <WorkflowTree :node-id="branches[0]!.target" />
    </template>
  </div>
</template>
