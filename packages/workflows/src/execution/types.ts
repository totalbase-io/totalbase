import type { WorkflowEngineContext } from "./context.js";
import type { DataPrincipal } from "@totalbase/mutations";
import type { RunState } from "./bindings.js";

/**
 * Carries a `totalbase.finish-error` step's own free-form, user-authored
 * `code` (e.g. "INVALID_ORDER" - see FinishErrorModal.vue) - deliberately
 * NOT a TotalBaseError, whose `code` must be one of the fixed
 * TOTALBASE_ERROR_CODES enum. This is opaque, workflow-author-defined
 * data, not a system error code.
 */
export class WorkflowOperationError extends Error {
  constructor(public readonly stepCode: string, message: string) {
    super(message);
  }
}

export interface OperationOutcome {
  /** The selected control output port (e.g. "next", "true"/"false") - null for a terminal step (Finish with error/result), which has no outputs at all (WorkflowTree.vue's TERMINAL_TYPES). */
  output: string | null;
  /** The data result this step produced - stored so a later step could reference it (source: "operation" binding), and recorded on the run step's own `result` column. */
  result: unknown;
}

/**
 * What a mutating handler (create/update/delete-records) needs to decide
 * what causal-ancestry chain (if any) to attach to its own audit row
 * (specs/Workflows.md §6.3, §5.1) - "workflow-origin
 * mutations default to no event emission. [opting in]... permits the
 * event path. The immutable causal ancestry then rejects a run whose
 * workflow UUID already appears, or whose next depth would exceed eight."
 * The opt-in itself is a per-operation `emitEvents` field on each Create/
 * Update/Delete records node's own `configuration` (CreateRecordsModal
 * .vue etc.) - deliberately not a single workflow-wide flag, since Execute
 * SQL/Execute function never participate in this at all regardless (see
 * `handlers.ts`'s own doc comment), so a workflow-level switch implied a
 * scope it never actually had. `ancestry` is this run's OWN incoming
 * chain (the workflows that already ran before this one, oldest first) -
 * empty for every non-DATA_EVENT trigger and for a DATA_EVENT run whose
 * own originating mutation wasn't itself workflow-sourced.
 */
export interface WorkflowRunContext {
  workflowId: string;
  ancestry: string[];
  /** The run, the step being executed and who caused the run - the correlation every audit row a step writes carries (Workflows.md §7.4). Set by the engine only, never from a payload. */
  runId: string;
  stepId: string;
  initiator: unknown;
  /** Aborted when the run is cancelled - a step waiting on I/O (an HTTP request) stops at once (Workflows.md §8.5). */
  signal?: AbortSignal;
  /** A TEST run's one address every Send email step goes to instead of its recipients (Workflows.md §11.1). Never set on a PRODUCTION run. */
  emailRedirect?: string;
}

/**
 * The `metadata` keys an audit row written by a workflow step carries
 * (Workflows.md §7.4): the workflow, the run (also the
 * `logs.workflow_run` column), the step and the run's initiator.
 * The actor stays the executor.
 */
export function workflowAuditCorrelation(workflowContext: WorkflowRunContext): Record<string, unknown> {
  return {
    workflow: workflowContext.workflowId,
    workflowRun: workflowContext.runId,
    workflowStep: workflowContext.stepId,
    workflowInitiator: workflowContext.initiator ?? null,
  };
}

export interface HandlerArgs {
  context: WorkflowEngineContext;
  dataPrincipal: DataPrincipal;
  configuration: Record<string, unknown>;
  state: RunState;
  workflowContext: WorkflowRunContext;
}

export type OperationHandler = (args: HandlerArgs) => Promise<OperationOutcome>;
