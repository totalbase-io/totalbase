// Shared read/write surface WorkflowTree.vue's recursive instances all
// `inject` from [id].vue, instead of drilling every callback through each
// recursion level as separate props.
export interface DraftNode {
  id: string
  type: string
  label: string
  /** Short reference id (letters/digits/underscores, <=20 chars) other steps use to refer to this one's output - not this node's internal `id` (a UUID, never shown). Start's is always fixed to "start", never user-edited. */
  key: string
  configuration: Record<string, unknown>
  /** Owning `totalbase.for-each` operation id, for a body-scoped node (Specification_Workflows.md §3.4) - undefined for a root-scope node. Set once by addStep() and inherited by every step chained after it within the same body; never edited afterward. */
  parent?: string
}

export interface WorkflowNodeView {
  kind: 'start' | 'condition' | 'action'
  icon: string
  title: string
  subtitle: string
  color: 'primary' | 'warning' | 'success' | 'info' | 'neutral'
  hasError?: boolean
}

export interface WorkflowTreeContext {
  /** True while the canvas is showing a read-only historical version (the Versions menu's preview) - hides every add/edit/delete affordance a card would otherwise offer; [id].vue's own onNodeClick/addStep/etc. no-op regardless, this just keeps the controls from rendering as dead buttons. */
  readOnly: boolean
  /** The workflow holds the most steps it may (Specification_Workflows.md §3.6) - every Add step entry is disabled, saying why. */
  operationLimitReached: boolean
  operationById(id: string): DraftNode | undefined
  nodeView(node: DraftNode): WorkflowNodeView
  /** Target node id of the (source, output) connection, if any. */
  connectionTarget(source: string, output: string): string | undefined
  onNodeClick(node: DraftNode): void
  addStep(source: string, output: string, type: string): void
  removeOperation(id: string): void
  /** Removes `id` plus every node reachable from it (any output, recursively) - for when `canDelete` is false and the caller confirmed the cascade. */
  removeOperationCascade(id: string): void
  canDelete(id: string): boolean
  /** Count of nodes reachable from `id` (any output, recursively) - not including `id` itself. 0 means `canDelete(id)` is true. */
  descendantCount(id: string): number
  /** Every OTHER node's `key` in the workflow (never includes `id`'s own) - what a step's own config modal validates a newly-typed key against for uniqueness. */
  otherKeys(id: string): string[]
}
