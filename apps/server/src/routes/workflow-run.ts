import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { cronStartData, manualInputFields, resolveDataPrincipalForConfiguredUser, runWorkflow, toRunResult, validateManualInput, type WorkflowRunResult } from "@totalbase/workflows";

interface DefinitionOperation {
  id: string;
  type: string;
  configuration: Record<string, unknown>;
}

/**
 * `POST /api/workflows/{slug}/run` - the internal (non-admin) trigger
 * surface for MANUAL/CRON-triggered workflows, addressed by slug like
 * the WEBHOOK route, for an authenticated app caller who isn't a
 * TotalBase Admin (e.g. a button on a form design). Deliberately NOT for
 * WEBHOOK-triggered workflows - those already have their own external
 * URL (workflow-webhooks.ts), no need to duplicate that surface here -
 * and NOT for DATA_EVENT, which has no notion of an HTTP caller at all.
 * Same MANUAL/CRON-only scope `execute-workflow.ts` already settled on
 * for the same reasoning (each trigger kind's own data contract).
 *
 * Unlike `execute-workflow.ts`'s synchronous engine-internal call (where
 * the caller is the workflow's own admin-authored step, an already-
 * trusted context), the caller here is an arbitrary authenticated
 * end user hitting this endpoint directly - so, unlike execute-workflow's
 * CRON branch, `WORKFLOW_INVOKE` is checked for BOTH trigger kinds, not
 * just MANUAL. Execution identity still follows each trigger kind's own
 * model: MANUAL runs as the calling principal, CRON runs as its own
 * configured `execute_as` (never the caller) and receives the schedule
 * object as Start data, exactly as its schedule would - only the "may
 * this caller even attempt it" gate is uniform here.
 *
 * The response is the run's outcome only, `{ id, status, result, error }`
 * (Workflows.md §13.1) - never its steps: their live inputs
 * and results are the author's to inspect (the Admin API's runs), not the
 * caller's. What a caller gets is what the Finish step returns.
 */
export function registerWorkflowRunRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Params: { slug: string }; Body: { data?: unknown } | null; Querystring: { async?: string } }>("/api/workflows/:slug/run", async (request, reply) => {
    const token = extractBearerToken(request);
    const caller = await resolveDataPrincipal(context, token, undefined, request);

    const found = await context.workflowsAdmin.getEnabledPublishedBySlug(request.params.slug);
    // Same "don't leak whether a disabled/nonexistent/wrong-trigger-kind
    // workflow merely exists" reasoning the WEBHOOK route's own handler
    // already established.
    if (!found) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "This workflow is not available.");
    const { workflow, definition } = found;
    const start = ((definition.operations as DefinitionOperation[] | undefined) ?? []).find((op) => op.type === "totalbase.start");
    const trigger = start?.configuration.trigger as string | undefined;
    if (trigger !== "MANUAL" && trigger !== "CRON") throw new TotalBaseError("WORKFLOW_NOT_FOUND", "This workflow is not available.");

    const decision = await context.workflowPermissions.resolveInvoke(caller.roleIds, workflow.id);
    if (decision !== "ALLOW") throw new TotalBaseError("ACTION_DENIED", "INVOKE is not authorized for this workflow.");

    let executor: DataPrincipal;
    if (trigger === "MANUAL") {
      // Its input form, when it declares one (§6.2); its "Execute as", else the caller.
      validateManualInput(manualInputFields(start?.configuration ?? {}), request.body?.data ?? null);
      const executeAs = start?.configuration.execute_as as string | undefined;
      executor = executeAs ? await resolveDataPrincipalForConfiguredUser(context, executeAs) : caller;
    } else {
      const executeAs = start?.configuration.execute_as as string | undefined;
      if (!executeAs) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This workflow has no execution user configured.");
      executor = await resolveDataPrincipalForConfiguredUser(context, executeAs);
    }

    // { data: input } (Data_API.md §2.4) - the workflow reads it as {{start.data}}.
    // A CRON workflow runs as its schedule would: the schedule object, not the request's data (§6.4.3).
    const input = trigger === "CRON" ? cronStartData(start?.configuration.timezone, new Date()) : request.body?.data ?? null;
    const admission = { trigger: trigger as "MANUAL" | "CRON", mode: "PRODUCTION" as const, initiator: { type: caller.principal.type, id: caller.principal.id } };

    // ?async=true (§13.1): 202 with the run as admitted; the caller polls GET /api/workflows/runs/{id}/result.
    if (request.query.async === "true") {
      const admitted = await new Promise<Parameters<typeof toRunResult>[0]>((resolve, reject) => {
        runWorkflow(context, executor, workflow, workflow.publishedVersion!, definition, admission, input, { onAdmitted: resolve }).catch(reject);
      });
      reply.code(202);
      return { data: toRunResult(admitted) satisfies WorkflowRunResult };
    }
    const outcome = await runWorkflow(context, executor, workflow, workflow.publishedVersion!, definition, admission, input);
    return { data: toRunResult(outcome.run) satisfies WorkflowRunResult };
  });
}
