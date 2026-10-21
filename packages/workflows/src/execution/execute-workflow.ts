import { TotalBaseError } from "@totalbase/errors";
import type { WorkflowEngineContext } from "./context.js";
import type { DataPrincipal } from "@totalbase/mutations";
import { resolveDataPrincipalForConfiguredUser } from "./context.js";
import { cronStartData } from "./cron.js";
import { runWorkflow, type WorkflowRunOutcome } from "./engine.js";
import { manualInputFields, validateManualInput } from "./manual-start.js";

interface DefinitionOperation {
  id: string;
  type: string;
  configuration: Record<string, unknown>;
}

/**
 * `totalbase.execute-workflow` (recursive invocation) - a synchronous,
 * in-process call, not an async dispatch, so it needs its own loop/depth
 * guard evaluated inline rather than the DATA_EVENT dispatcher's own
 * (data-event-dispatcher.ts) - same rule (a repeated workflow id anywhere
 * in the chain, or a chain longer than `workflows.max_chain_depth`, is rejected), same `ancestry` shape, just
 * checked synchronously before recursing instead of read back later from
 * an audit row's metadata.
 *
 * Deliberately narrowed to MANUAL- and CRON-triggered targets only,
 * agreed with the user: a DATA_EVENT target's own Start expects the
 * transactionally-captured record(s) from a real table mutation
 * (Workflows.md §6.3) - there is no real mutation here, so there's nothing honest to
 * fabricate for it. A WEBHOOK target's own contract (`{query, body}`,
 * PUBLIC/AUTHENTICATED access, rate limiting, sync/async response modes)
 * is an HTTP-layer concern this internal call has no use for - a workflow
 * that wants to be both externally callable and invokable from another
 * workflow can just use MANUAL for that (WEBHOOK adds no reachable
 * workflow a MANUAL target doesn't already cover for this purpose).
 *
 * Identity mirrors each trigger kind's own existing model rather than
 * inventing a third one: a MANUAL target runs as the CALLING workflow's
 * own principal, gated by the same `WORKFLOW_INVOKE` grant
 * `runWorkflowManual` already enforces for an HTTP-triggered manual run
 * (this is, structurally, exactly that - just invoked from inside a
 * workflow instead of an HTTP request). A CRON target runs as its own
 * configured `execute_as`, unchecked against the caller's own grants -
 * CRON workflows never have an "invoking identity" concept even when
 * their own scheduler ticks them, so this doesn't introduce one.
 */
export async function invokeSubWorkflow(
  context: WorkflowEngineContext,
  params: {
    callerPrincipal: DataPrincipal;
    callerWorkflowId: string;
    ancestry: string[];
    targetWorkflowId: string;
    input: unknown;
  },
): Promise<WorkflowRunOutcome> {
  const fullChain = [...params.ancestry, params.callerWorkflowId];
  if (fullChain.includes(params.targetWorkflowId)) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step would create a workflow invocation loop (the target workflow already appears earlier in this call chain).");
  }
  const maxChainDepth = await context.settings.get("workflows.max_chain_depth");
  if (fullChain.length >= maxChainDepth) {
    throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `This workflow invocation chain would exceed the maximum depth of ${maxChainDepth} (workflows.max_chain_depth).`);
  }

  const target = await context.workflowsAdmin.get(params.targetWorkflowId).catch(() => undefined);
  if (!target || !target.enabled || !target.publishedVersion) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "The target workflow must be published and enabled.");
  }
  const { definition } = await context.workflowsAdmin.getPublished(params.targetWorkflowId);
  const start = ((definition.operations as DefinitionOperation[] | undefined) ?? []).find((op) => op.type === "totalbase.start");
  const targetTrigger = start?.configuration.trigger as string | undefined;

  let executor: DataPrincipal;
  if (targetTrigger === "MANUAL") {
    const decision = await context.workflowPermissions.resolveInvoke(params.callerPrincipal.roleIds, params.targetWorkflowId);
    if (decision !== "ALLOW") throw new TotalBaseError("ACTION_DENIED", "INVOKE is not authorized for the target workflow.");
    // Its own "Execute as" when set (§6.2), else the calling workflow's executor; its input form checked like any caller's.
    validateManualInput(manualInputFields(start?.configuration ?? {}), params.input);
    const ownExecuteAs = start?.configuration.execute_as as string | undefined;
    executor = ownExecuteAs ? await resolveDataPrincipalForConfiguredUser(context, ownExecuteAs) : params.callerPrincipal;
  } else if (targetTrigger === "CRON") {
    const executeAs = start?.configuration.execute_as as string | undefined;
    if (!executeAs) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "The target workflow has no execute_as user configured.");
    executor = await resolveDataPrincipalForConfiguredUser(context, executeAs);
  } else {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "Only a MANUAL- or CRON-triggered workflow can be invoked with Execute workflow.");
  }

  return runWorkflow(
    context,
    executor,
    target,
    target.publishedVersion!,
    definition,
    {
      trigger: targetTrigger,
      mode: "PRODUCTION",
      initiator: { type: "EXECUTE_WORKFLOW", workflow: params.callerWorkflowId },
      ancestry: fullChain,
    },
    // A CRON target runs as its schedule would (§6.4.3): the schedule object, not the step's input.
    targetTrigger === "CRON" ? cronStartData(start?.configuration.timezone, new Date()) : params.input,
  );
}
