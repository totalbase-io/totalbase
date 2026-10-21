import { randomUUID } from "node:crypto";
import { TotalBaseError, deniedMessage } from "@totalbase/errors";
import { OPERATION_CATALOG } from "@totalbase/tb-catalog";
import { compileSelect, parseFilter, parseQuery, SchemaContext, type FilterNode } from "@totalbase/query-engine";
import type { WorkflowEngineContext } from "./context.js";
import type { DataPrincipal } from "@totalbase/mutations";
import { buildRowFilter, executeCreate, executeDelete, executeUpdate, loadPasswordColumns, protectedFieldDecision, rowFilterLimits as loadLimits, userVariableResolver, withPasswordColumnsDenied, type MutationDeps } from "@totalbase/mutations";
import { evaluateFilter } from "./filter-evaluator.js";
import { resolveWorkflowResource } from "./resource-resolution.js";
import { CODE_HANDLERS } from "./code-handlers.js";
import { SIGN_HANDLERS } from "./sign-handlers.js";
import { SOAP_HANDLERS } from "./soap-handlers.js";
import { DOCUMENT_HANDLERS } from "./document-handlers.js";
import { EMAIL_HANDLERS } from "./email-handlers.js";
import { WAIT_RESUME_HANDLERS } from "./wait-resume-handlers.js";
import { FILE_HANDLERS } from "./file-handlers.js";
import { WorkflowOperationError, workflowAuditCorrelation, type OperationHandler, type WorkflowRunContext } from "./types.js";

export { WorkflowOperationError, workflowAuditCorrelation, type OperationHandler, type OperationOutcome, type HandlerArgs, type WorkflowRunContext } from "./types.js";

async function mutationDeps(context: WorkflowEngineContext, dataPrincipal: DataPrincipal, resourceId: string | undefined, workflowContext: WorkflowRunContext, emitEvents: boolean): Promise<{ deps: MutationDeps }> {
  const resource = await resolveWorkflowResource(context, resourceId as string | undefined);
  const limits = await loadLimits(context);
  const schemaContext = new SchemaContext(context.database);
  const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);
  // Workflows.md §6.3.4: "workflow-origin mutations default to no event emission...
  // permits the event path" - opted in per-step via this operation's own
  // `configuration.emitEvents` (CreateRecordsModal.vue etc.), not a
  // workflow-wide flag (see WorkflowRunContext's own doc comment on why).
  // `null` here is what data-event-dispatcher.ts reads back as "this
  // workflow-sourced mutation opted out"; a real array is this run's own
  // incoming ancestry plus itself, letting a downstream DATA_EVENT
  // admission know the full chain so far.
  const workflowAncestry = emitEvents ? [...workflowContext.ancestry, workflowContext.workflowId] : null;
  return {
    deps: {
      context,
      dataPrincipal,
      resourceId: resource.id,
      root,
      limits,
      audit: { requestId: randomUUID(), source: "workflow", workflowAncestry, workflowCorrelation: workflowAuditCorrelation(workflowContext) },
    },
  };
}

const readRecords: OperationHandler = async ({ context, dataPrincipal, configuration }) => {
  const resource = await resolveWorkflowResource(context, configuration.resource as string | undefined, ["TABLE", "VIEW"]);
  const limits = await loadLimits(context);
  const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resource.id, "READ");
  if (permission.action !== "ALLOW") throw new TotalBaseError("ACTION_DENIED", deniedMessage("READ", resource.schema, resource.name));

  const [defaultLimit, maxLimit, maxOffset, maxQueryNodes] = await Promise.all([
    context.settings.get("api.default_limit"),
    context.settings.get("api.max_limit"),
    context.settings.get("api.max_offset"),
    context.settings.get("api.max_query_nodes"),
  ]);
  const ast = parseQuery((configuration.query as Record<string, unknown> | undefined) ?? {}, { ...limits, maxQueryNodes });
  const schemaContext = new SchemaContext(context.database);
  const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);
  const rowFilter = buildRowFilter(permission, limits);
  const passwordColumns = await loadPasswordColumns(context, resource.id);

  const compiled = await compileSelect({
    root,
    ast,
    schemaContext,
    fieldDecision: withPasswordColumnsDenied(protectedFieldDecision(root, permission.fieldDecision), passwordColumns),
    rowFilter,
    resolveUserVariable: userVariableResolver(dataPrincipal),
    defaultLimit,
    maxLimit,
    maxOffset,
    defaultOrderBy: resource.defaultSort,
  });
  const { rows } = await context.database.query(compiled.sql, compiled.params);
  return { output: "next", result: rows };
};

/**
 * `records` is a literal JSON array the author types directly (back to
 * this shape after the chat's own reconsideration of the earlier
 * structured-Binding picker) - `{{operation.data.field}}` expressions
 * (templates.ts) can appear anywhere inside it, at any depth, so a single
 * object can mix literal and dynamic fields freely (`{"name": "{{start.
 * data.name}}", "source": "workflow"}`), which the old "the whole field
 * comes from exactly one source" binding model couldn't do. Already
 * resolved by the time it reaches here - engine.ts's own `walk()` runs
 * `resolveTemplates()` on this operation's whole `configuration` before
 * persisting its step and before calling this handler, specifically so
 * the step's own stored `input` reflects the real values used (visible in
 * the Logs sidebar even when the step then fails, e.g. a unique-violation
 * on the very record it tried to insert).
 */
const createRecords: OperationHandler = async ({ context, dataPrincipal, configuration, workflowContext }) => {
  const { deps } = await mutationDeps(context, dataPrincipal, configuration.resource as string | undefined, workflowContext, configuration.emitEvents === true);
  const resolved = configuration.records ?? [];
  if (!Array.isArray(resolved)) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's records must resolve to an array.");
  const results = await executeCreate(deps, resolved as Record<string, unknown>[], undefined);
  return { output: "next", result: results };
};

/** A step's `where`, or undefined when it has none - an empty object counts as none. */
function stepWhere(configuration: Record<string, unknown>): unknown {
  const where = configuration.where;
  if (where === undefined || where === null) return undefined;
  if (typeof where === "object" && !Array.isArray(where) && Object.keys(where).length === 0) return undefined;
  return where;
}

/**
 * Update/Delete records follow the Data API's own guard (Workflows.md
 * §5.4, §5.5): with `api.require_where_for_update` / `_delete` on, a step
 * without a `where` is refused - at publish (readiness.ts) and here, at run
 * time, with the Data API's own code.
 */
export async function assertWhereRequirement(context: Pick<WorkflowEngineContext, "settings">, type: string, configuration: Record<string, unknown>): Promise<void> {
  const verb = type === "totalbase.update-records" ? "UPDATE" : type === "totalbase.delete-records" ? "DELETE" : undefined;
  if (!verb || stepWhere(configuration) !== undefined) return;
  const key = verb === "UPDATE" ? "api.require_where_for_update" : "api.require_where_for_delete";
  if (await context.settings.get(key)) {
    throw new TotalBaseError("INVALID_QUERY", `where is required for collection ${verb} (${key}).`);
  }
}

/** `set` is a literal JSON object with `{{...}}` templates, already resolved before this handler runs - see `createRecords`'s own doc comment. */
const updateRecords: OperationHandler = async ({ context, dataPrincipal, configuration, workflowContext }) => {
  await assertWhereRequirement(context, "totalbase.update-records", configuration);
  const { deps } = await mutationDeps(context, dataPrincipal, configuration.resource as string | undefined, workflowContext, configuration.emitEvents === true);
  const whereRaw = stepWhere(configuration);
  const where = whereRaw !== undefined ? parseFilter(whereRaw, deps.limits, 0) : undefined;
  const resolvedSet = configuration.set ?? {};
  if (typeof resolvedSet !== "object" || resolvedSet === null || Array.isArray(resolvedSet)) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's `set` must resolve to an object.");
  }
  const results = await executeUpdate(deps, [{ data: resolvedSet as Record<string, unknown>, where }], false);
  return { output: "next", result: results };
};

const deleteRecords: OperationHandler = async ({ context, dataPrincipal, configuration, workflowContext }) => {
  await assertWhereRequirement(context, "totalbase.delete-records", configuration);
  const { deps } = await mutationDeps(context, dataPrincipal, configuration.resource as string | undefined, workflowContext, configuration.emitEvents === true);
  const whereRaw = stepWhere(configuration);
  const where: FilterNode | undefined = whereRaw !== undefined ? parseFilter(whereRaw, deps.limits, 0) : undefined;
  const results = await executeDelete(deps, [{ where }], false);
  return { output: "next", result: results };
};

/** `input` may contain `{{operation.data...}}` expressions - already resolved by the time it reaches here (engine.ts's own `TEMPLATED_OPERATION_TYPES`), so this just reads it directly (a plain literal, not a `Binding`, since `ConditionModal.vue` reverted from that picker). */
const condition: OperationHandler = async ({ configuration }) => {
  const input = configuration.input ?? null;
  const filterRaw = configuration.filter as Record<string, unknown> | undefined;
  if (!filterRaw || Object.keys(filterRaw).length === 0) return { output: "true", result: input };
  const node = parseFilter(filterRaw, { maxFilterDepth: 10, maxRelationDepth: 3 }, 0);
  return { output: evaluateFilter(node, input) ? "true" : "false", result: input };
};

/**
 * `totalbase.validate-data` (Workflows.md §5.9.1): checks
 * `input` against `rules`, each `{ filter, message }` in the one filter
 * grammar, evaluated like Condition (AGENTS.md §7 - no second grammar). All
 * rules pass: `next` with the input. Any fails: the step fails with
 * WORKFLOW_VALIDATION_FAILED listing every failed rule's message - its
 * `error` output when connected, the run otherwise.
 *
 * The configuration arrives template-resolved (the engine's
 * TEMPLATED_OPERATION_TYPES lists this type).
 */
const validateData: OperationHandler = async ({ configuration }) => {
  const input = configuration.input ?? null;
  const rules = configuration.rules ?? [];
  if (!Array.isArray(rules)) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's rules must be a list of { filter, message }.");
  const failures: { rule: number; message: string }[] = [];
  rules.forEach((rule: unknown, index) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Rule ${index + 1} must be { filter, message }.`);
    const { filter, message } = rule as { filter?: unknown; message?: unknown };
    if (filter === undefined || filter === null || (typeof filter === "object" && Object.keys(filter).length === 0)) return;
    const node = parseFilter(filter, { maxFilterDepth: 10, maxRelationDepth: 3 }, 0);
    if (!evaluateFilter(node, input)) {
      failures.push({ rule: index + 1, message: typeof message === "string" && message.trim() ? message.trim() : `Rule ${index + 1} failed.` });
    }
  });
  if (failures.length) {
    throw new TotalBaseError("WORKFLOW_VALIDATION_FAILED", `Validation failed: ${failures.map((failure) => failure.message).join("; ")}`, { detail: JSON.stringify(failures) });
  }
  return { output: "next", result: input };
};

/**
 * `totalbase.select-case` (specs/Workflows.md §5.10):
 * "evaluates ordered Condition-style predicates on one object and chooses
 * the first matching named output... It has an optional `default` output
 * and `error`; no match without a default is an error." Reuses the exact
 * same filter grammar/evaluator Condition already uses - this is that
 * operation's multi-branch counterpart, not a second filter engine.
 * `input` already resolved - see `condition`'s own doc comment.
 */
const selectCase: OperationHandler = async ({ configuration }) => {
  const input = configuration.input ?? null;
  const cases = (configuration.cases as { output: string; filter: Record<string, unknown> }[] | undefined) ?? [];
  for (const c of cases) {
    const node = parseFilter(c.filter, { maxFilterDepth: 10, maxRelationDepth: 3 }, 0);
    if (evaluateFilter(node, input)) return { output: c.output, result: input };
  }
  if (configuration.hasDefault) return { output: "default", result: input };
  throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "No case matched this input and no default branch is configured.");
};

/** `result` may contain `{{operation.data...}}` expressions - already resolved by the time it reaches here (engine.ts's own `TEMPLATED_OPERATION_TYPES`), so this just echoes it. */
const finishResult: OperationHandler = async ({ configuration }) => ({ output: null, result: configuration.result ?? null });

/** `message`/`code` may contain `{{operation.data...}}` expressions - already resolved by the time they reach here, same as `finishResult`'s own doc comment. */
const finishError: OperationHandler = async ({ configuration }) => {
  throw new WorkflowOperationError(
    (configuration.code as string | undefined) ?? "WORKFLOW_FINISHED_WITH_ERROR",
    (configuration.message as string | undefined) ?? "Workflow stopped with an error.",
  );
};

/**
 * `totalbase.execute-workflow` - see execute-workflow.ts's own doc comment
 * for the full design (MANUAL/CRON targets only, identity per trigger
 * kind, synchronous ancestry/loop check). Delegates to `context.
 * invokeSubWorkflow()` rather than importing engine.ts's `runWorkflow`
 * directly - engine.ts imports OPERATION_HANDLERS from this very file, so
 * a direct import here would be circular.
 */
const executeWorkflow: OperationHandler = async ({ context, dataPrincipal, configuration, workflowContext }) => {
  const targetWorkflowId = configuration.workflow as string | undefined;
  if (!targetWorkflowId) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no workflow configured.");
  const input = configuration.input ?? null;
  const outcome = await context.invokeSubWorkflow({
    callerPrincipal: dataPrincipal,
    callerWorkflowId: workflowContext.workflowId,
    ancestry: workflowContext.ancestry,
    targetWorkflowId,
    input,
  });
  if (outcome.run.status === "FAILED") {
    const errorMessage = outcome.run.error && typeof outcome.run.error === "object" && "message" in outcome.run.error ? String((outcome.run.error as { message: unknown }).message) : "The invoked workflow finished with an error.";
    throw new TotalBaseError("WORKFLOW_EXECUTION_FAILED", errorMessage);
  }
  return { output: "next", result: { run: outcome.run.id, status: outcome.run.status, result: outcome.run.result } };
};

/**
 * Native operation registry (specs/Workflows.md §5.25):
 * the handler of every operation the catalog (`OPERATION_CATALOG`,
 * `@totalbase/tb-catalog`) says `runs: "handler"` - its test keeps the two
 * equal. No dynamic plugin loading. `totalbase.for-each`/`totalbase.process-batches`
 * aren't here - they're engine-native control-flow, dispatched directly
 * inside engine.ts's own `walk()` (see its doc comment). An operation with
 * no handler fails the run with WORKFLOW_INVALID_DESIGN rather than
 * silently no-op'ing.
 */
export const OPERATION_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.condition": condition,
  "totalbase.select-case": selectCase,
  "totalbase.validate-data": validateData,
  "totalbase.execute-workflow": executeWorkflow,
  "totalbase.finish-result": finishResult,
  "totalbase.finish-error": finishError,
  "totalbase.read-records": readRecords,
  "totalbase.create-records": createRecords,
  "totalbase.update-records": updateRecords,
  "totalbase.delete-records": deleteRecords,
  ...CODE_HANDLERS,
  ...SOAP_HANDLERS,
  ...SIGN_HANDLERS,
  ...FILE_HANDLERS,
  ...DOCUMENT_HANDLERS,
  ...EMAIL_HANDLERS,
  ...WAIT_RESUME_HANDLERS,
};

/** The steps a run (or a loop item) ends at - the catalog's operations without output ports (§3.3). */
export const TERMINAL_OPERATION_TYPES: ReadonlySet<string> = new Set(OPERATION_CATALOG.filter((definition) => definition.outputs.length === 0).map((definition) => definition.type));
