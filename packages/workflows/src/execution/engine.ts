import { TotalBaseError } from "@totalbase/errors";
import { OPERATION_CATALOG } from "@totalbase/tb-catalog";
import { manualInputFields, validateManualInput } from "./manual-start.js";
import type { WorkflowRecord } from "../workflows-admin-service.js";
import type { WorkflowRunMode, WorkflowRunRecord, WorkflowRunStatus, WorkflowRunStepRecord, WorkflowRunTrigger } from "../workflow-runs-service.js";
import type { WorkflowEngineContext } from "./context.js";
import { resolveDataPrincipalForConfiguredUser } from "./context.js";
import type { DataPrincipal } from "@totalbase/mutations";
import { cronStartData } from "./cron.js";
import { OPERATION_HANDLERS, TERMINAL_OPERATION_TYPES, WorkflowOperationError, type OperationOutcome, type WorkflowRunContext } from "./handlers.js";
import type { RunState } from "./bindings.js";
import { resolveTemplates } from "./templates.js";
import { sanitizeError, sanitizePayload, type HistoryPolicy } from "./history-sanitizer.js";

/**
 * Operation types whose whole `configuration` may contain `{{...}}`
 * templates (templates.ts, Specification_Workflows.md §4.3) - the operation
 * catalog's `templates: "configuration"`. Resolved centrally here, before
 * the step is even persisted, so `workflows_steps.input` holds
 * the real values the step used (the exact record a Create records step
 * tried to insert), whether it then succeeds or fails. The loops resolve
 * only their list (`items`, `source`); Execute SQL, Execute JavaScript and
 * Wait take theirs literally.
 */
export const TEMPLATED_OPERATION_TYPES: ReadonlySet<string> = new Set(OPERATION_CATALOG.filter((definition) => definition.templates === "configuration").map((definition) => definition.type));

interface DefinitionOperation {
  id: string;
  key: string;
  type: string;
  configuration_version?: number;
  configuration: Record<string, unknown>;
  /** Owning `totalbase.for-each` operation id, for a body-scoped node - see WORKFLOW_EDITOR's own addStep() (apps/admin's [id].vue). The engine itself never reads this: it walks whatever connections exist regardless of scope (Specification_Workflows.md §3.4's "canvas position ... never define a loop" applies just as much to the engine as to the editor) - `parent` is purely a draft-save-time/editor bookkeeping field. */
  parent?: string;
}
interface DefinitionConnection {
  source: string;
  target: string;
  output: string;
}

export interface WorkflowRunOutcome {
  /** `.result`/`.error` reflect the LIVE, unredacted values from this call - see the doc comment below on why the stored/history copy can differ. */
  run: WorkflowRunRecord;
  steps: WorkflowRunStepRecord[];
}

/**
 * What a caller of the public HTTP routes gets back from a run
 * (Specification_Workflows.md §13): its outcome only - the workflow author
 * decides what that is through the Finish step's result. Steps (their live
 * inputs and results, a webhook's headers included) stay with the
 * administrator: the Admin API's test run, editor run and history.
 */
export interface WorkflowRunResult {
  id: string;
  status: WorkflowRunRecord["status"];
  result: unknown;
  error: unknown;
}

export function toRunResult(run: Pick<WorkflowRunRecord, "id" | "status" | "result" | "error">): WorkflowRunResult {
  return { id: run.id, status: run.status, result: run.result ?? null, error: run.error ?? null };
}

/** A step's error: `{ code, message }`, plus `detail` when the error carries one (Validate data's failed rules) - parsed when it is JSON. */
type StepError = { code: string; message: string; detail?: unknown };

function toStepError(error: unknown): StepError {
  if (error instanceof TotalBaseError) {
    if (error.detail === undefined) return { code: error.code, message: error.message };
    let detail: unknown = error.detail;
    try {
      const parsed: unknown = JSON.parse(error.detail);
      if (typeof parsed === "object" && parsed !== null) detail = parsed;
    } catch {
      // not JSON: kept as text
    }
    return { code: error.code, message: error.message, detail };
  }
  if (error instanceof WorkflowOperationError) return { code: error.stepCode, message: error.message };
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

/** Splits an array into fixed-size chunks - `totalbase.process-batches`' own transform. */
function chunk<T>(source: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < source.length; i += size) batches.push(source.slice(i, i + size));
  return batches;
}

/**
 * Runs a workflow's current DRAFT synchronously, admin-triggered
 * ("Probar"/test-run - specs/Specification_Workflows.md §10:
 * "Test runs from the editor execute the current draft directly, are
 * always manual/synchronous"). Never touches `published` - see
 * WorkflowsAdminService, which doesn't implement publish() yet either
 * (Fase 6).
 *
 * Sequential engine (Specification_Workflows.md §8.1, §8.3): one active control path, no
 * fan-out, no parallelism, no automatic retries. Three distinct
 * concepts per step: the data `result` a handler returns, the control
 * `output` port it selects (ordinary ops: next/error; Condition:
 * true/false/error), and the run's own terminal outcome. An operation
 * whose handler throws follows ITS OWN "error" connection if the editor
 * wired one; if not, the run fails - this is also how `totalbase.
 * finish-error` naturally produces a failed run with its own
 * (WorkflowOperationError) code/message, without any special-casing:
 * it's a terminal type (WorkflowTree.vue's TERMINAL_TYPES) with no
 * outputs at all, so its thrown error can never find a wired "error"
 * connection to continue down.
 *
 * History policy (Specification_Workflows.md §9) governs what's PERSISTED (SUMMARY
 * never stores a payload, DETAILED stores it redacted/capped) - it does
 * NOT govern what this function returns to the admin who just clicked
 * "Probar". A test run's whole point is to show its author what
 * happened; hiding the result because the workflow's own history_level
 * happens to be SUMMARY would defeat that. So the returned `run`/`steps`
 * carry the live, unredacted values collected during this call, while
 * the DB rows underneath them hold whatever the history policy allows -
 * two representations of the same run, by design.
 */
export async function runWorkflowTest(context: WorkflowEngineContext, dataPrincipal: DataPrincipal, workflowId: string, triggerInput: unknown): Promise<WorkflowRunOutcome> {
  const { workflow, definition } = await context.workflowsAdmin.getDraft(workflowId);
  // The draft isn't a version (Specification.md §13.3): a test run records version = NULL.
  return runWorkflow(context, dataPrincipal, workflow, null, definition, { trigger: "MANUAL", mode: "TEST" }, triggerInput);
}

/**
 * The editor's Run (Specification_Workflows.md §11.2): the immutable
 * **published** version, mode PRODUCTION. Requires `enabled = true` and a
 * WORKFLOW_INVOKE ALLOW for the caller (test runs bypass it: testing a
 * draft is not the question "may this principal invoke it in production").
 *
 * A MANUAL workflow runs as the caller with the caller's input. A CRON
 * workflow runs exactly as its schedule would - as its `execute_as`, with
 * the schedule object as Start data (`scheduled_at` = now; the request's
 * input is not used) - and is recorded with trigger CRON and the caller as
 * initiator, which tells it apart from a scheduled occurrence (initiator
 * `{ type: "CRON", scheduledAt }`).
 */
export async function runWorkflowManual(context: WorkflowEngineContext, dataPrincipal: DataPrincipal, workflowId: string, triggerInput: unknown): Promise<WorkflowRunOutcome> {
  const workflow = await context.workflowsAdmin.get(workflowId);
  if (!workflow.enabled) throw new TotalBaseError("WORKFLOW_DISABLED", "This workflow is not enabled.");
  const decision = await context.workflowPermissions.resolveInvoke(dataPrincipal.roleIds, workflowId);
  if (decision !== "ALLOW") throw new TotalBaseError("ACTION_DENIED", "INVOKE is not authorized for this workflow.");
  // Version id and definition from the same read, so they can't disagree if a publish lands in between.
  const { workflow: live, definition } = await context.workflowsAdmin.getPublished(workflowId);
  // Same trigger kinds POST /api/workflows/{slug}/run admits: a webhook has
  // its sender's payload contract, a data event its row.
  const operations = (definition.operations as { type: string; configuration?: Record<string, unknown> }[] | undefined) ?? [];
  const startConfiguration = operations.find((op) => op.type === "totalbase.start")?.configuration ?? {};
  const trigger = startConfiguration.trigger;
  if (trigger !== "MANUAL" && trigger !== "CRON") {
    throw new TotalBaseError("WORKFLOW_NOT_RUNNABLE", `A ${String(trigger ?? "unconfigured")} workflow runs from its own trigger, not on demand.`);
  }
  const initiator = { type: dataPrincipal.principal.type, id: dataPrincipal.principal.id };
  if (trigger === "CRON") {
    const executeAs = startConfiguration.execute_as as string | undefined;
    if (!executeAs) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This workflow has no execution user configured.");
    const executor = await resolveDataPrincipalForConfiguredUser(context, executeAs);
    const now = new Date();
    return runWorkflow(context, executor, live, live.publishedVersion!, definition, { trigger: "CRON", mode: "PRODUCTION", initiator }, cronStartData(startConfiguration.timezone, now, now));
  }
  validateManualInput(manualInputFields(startConfiguration), triggerInput);
  // "Execute as" (§6.2): the caller by default, or the user an administrator configured - the caller stays the initiator.
  const executeAs = startConfiguration.execute_as as string | undefined;
  const executor = executeAs ? await resolveDataPrincipalForConfiguredUser(context, executeAs) : dataPrincipal;
  return runWorkflow(context, executor, live, live.publishedVersion!, definition, { trigger: "MANUAL", mode: "PRODUCTION", initiator }, triggerInput);
}

/**
 * Runs executing in this process, by run id - each one's cooperative
 * cancel token (Specification_Workflows.md §8.5). TotalBase runs as one
 * process, so this is every run that can be cancelled; a RUNNING row that
 * is not here belongs to a process that died and is left to recovery.
 */
const IN_PROCESS_RUNS = new Map<string, { cancelled: boolean; controller?: AbortController }>();

/**
 * Requests cooperative cancellation of a run executing in this process:
 * the running step finishes, no further step starts and the run ends
 * CANCELLED. False when the run is not executing here.
 */
export function requestRunCancellation(runId: string): boolean {
  const token = IN_PROCESS_RUNS.get(runId);
  if (!token) return false;
  token.cancelled = true;
  // A step waiting on I/O stops now rather than at its own end.
  token.controller?.abort();
  return true;
}

/**
 * Records a background admission (CRON/DATA_EVENT) that was suppressed
 * BEFORE a real run could even be attempted - a causal-ancestry loop, an
 * excessive chain depth, an oversized triggering payload, or an
 * unresolvable `execute_as` - as a real, visible FAILED run (with a
 * FAILED Start step carrying the actual reason), the same "why didn't
 * this fire" question a genuinely-failed run already answers via Logs.
 * Reuses the exact same run/step primitives `runWorkflow()` itself calls
 * (`createRun`/`insertStep`/`finishStep`/`finishRun`) rather than a
 * separate diagnostics store - the user's own idea, after `runWorkflow()`
 * turned out to already have everything needed.
 *
 * Deliberately narrow: only ever called for a suppression that's already
 * naturally rate-limited to once per REAL triggering event (a row
 * mutation for DATA_EVENT, a matched+claimed occurrence for CRON) - never
 * for `cron-dispatcher.ts`'s own pre-match config-validation checks
 * (missing/invalid `cron_expression`/`timezone`/`execute_as`), which run
 * on every 15s tick regardless of whether the schedule matches at all;
 * turning those into a run too would flood a broken CRON workflow's own
 * history with thousands of near-identical rows a day instead of one
 * useful signal - discussed and explicitly ruled out. Those two remain
 * log-only (`context.logger.warn`), unchanged.
 *
 * No `executor` may exist yet for some callers (an ancestry-loop/depth
 * rejection, or `execute_as` itself being the very thing that's broken) -
 * `admission.executor` is optional; a synthetic `{ type: "SYSTEM" }`
 * descriptor is used when absent, same principal-type vocabulary
 * `logs.principal_type` already uses elsewhere in this project.
 */
export async function recordSuppressedAdmission(
  context: WorkflowEngineContext,
  workflow: WorkflowRecord,
  definition: Record<string, unknown>,
  admission: {
    trigger: WorkflowRunTrigger; initiator: unknown; executor?: unknown;
    /** A DATA_EVENT suppression is recorded once per outbox event (§6.3.5): a retried event skips it. */
    outboxClaim?: OutboxAdmissionClaim;
  },
  suppressionError: { code: string; message: string },
  /** False for a skipped CRON occurrence (§6.4.3): the previous run still working is not a failure of the workflow. */
  options: { countsTowardAutoDisable?: boolean } = {},
): Promise<void> {
  const operations = (definition.operations as DefinitionOperation[] | undefined) ?? [];
  const start = operations.find((op) => op.type === "totalbase.start");
  if (!start) return; // can't happen for an already-published workflow, but nothing useful to record without a Start node.

  const [maxRunMs, maxPayloadBytes] = await Promise.all([
    context.settings.get("workflows.max_run_duration_ms"),
    context.settings.get("workflows.max_history_payload_bytes"),
  ]);
  const historyPolicy: HistoryPolicy = { historyLevel: workflow.historyLevel, maxPayloadBytes };
  const executor = admission.executor ?? { type: "SYSTEM" };

  const runInput = {
    workflow: workflow.id,
    version: workflow.publishedVersion!,
    trigger: admission.trigger,
    mode: "PRODUCTION" as const,
    initiator: admission.initiator,
    executor,
    historyEnabled: workflow.historyEnabled,
    historyLevel: workflow.historyLevel,
    expiresAt: new Date(Date.now() + maxRunMs),
  };
  const run = admission.outboxClaim
    ? await context.workflowRuns.createRunForOutboxEvent(runInput, admission.outboxClaim)
    : await context.workflowRuns.createRun(runInput);
  if (!run) return; // an earlier attempt at this outbox event already recorded it.
  const step = await context.workflowRuns.insertStep({
    run: run.id,
    operation: start.id,
    operationType: start.type,
    configurationVersion: start.configuration_version ?? 1,
    sequence: 1,
    predecessor: null,
    input: sanitizePayload(start.configuration, historyPolicy),
  });
  await context.workflowRuns.finishStep(step.id, { status: "FAILED", selectedOutput: null, error: sanitizeError(suppressionError, historyPolicy) });
  await context.workflowRuns.finishRun(run.id, { status: "FAILED", error: sanitizeError(suppressionError, historyPolicy) });
  // Same accounting a genuinely-failed real run already gets (engine.ts's
  // own post-finishRun call) - a workflow suppressed on every admission
  // attempt (e.g. a permanently-unresolvable execute_as) should trip the
  // same auto-disable protection as one that runs but keeps failing.
  if (options.countsTowardAutoDisable === false) return;
  const threshold = await context.settings.get("workflows.auto_disable_after_consecutive_failures");
  await context.workflowsAdmin.recordRunOutcome(workflow.id, "FAILED", threshold);
}

/** The claim a DATA_EVENT admission takes (Specification_Workflows.md §6.3.5): the outbox event and the record's position in its payload - null for a suppression of the workflow as a whole. */
export interface OutboxAdmissionClaim {
  event: string;
  item: number | null;
}

export interface RunAdmission {
  trigger: WorkflowRunTrigger;
  mode: WorkflowRunMode;
  initiator?: unknown;
  /** This run's own incoming causal-ancestry chain (Specification_Workflows.md §6.3.4) - only ever non-empty for a DATA_EVENT admission whose originating mutation was itself workflow-sourced with `emit_workflow_events = true` (data-event-dispatcher.ts). Every other trigger kind can never be caused by a mutation, so it stays empty. */
  ancestry?: string[];
  /** A DATA_EVENT admission's claim: the run is created only if no earlier attempt at that outbox event took it (§6.3.5). */
  outboxClaim?: OutboxAdmissionClaim;
}

export interface RunOptions {
  /** Called the moment the run row exists (well before execution finishes) - the WEBHOOK route's own SYNC/ASYNC split (Specification_Workflows.md §13.2) needs the run id immediately, without waiting for the run to complete. */
  onAdmitted?: (run: WorkflowRunRecord) => void;
  /**
   * Cooperative cancellation (Specification_Workflows.md §8.5: "must stop cooperatively
   * before starting further work... prevents the next invocation,
   * and becomes CANCELLED when the active handler returns"), checked
   * once per step boundary inside `walk()` - never mid-handler, since
   * nothing in today's synchronous engine can preempt a handler
   * that's already running. Set by the WEBHOOK route's own SYNC
   * timeout-action handling (CANCEL).
   */
  cancelToken?: { cancelled: boolean };
}

/**
 * The shared engine core every trigger's own thin entry point (test run,
 * production manual run, and now DATA_EVENT admission) funnels through -
 * exported so a trigger dispatcher (apps/server/src/workflow-execution/
 * data-event-dispatcher.ts) can admit a run against an already-resolved
 * workflow/version/principal/trigger-input without re-deriving any of
 * runWorkflowTest/runWorkflowManual's own draft-vs-published or
 * permission-check logic, which doesn't apply the same way for an
 * automatic trigger.
 */
export async function runWorkflow(
  context: WorkflowEngineContext,
  dataPrincipal: DataPrincipal,
  workflow: WorkflowRecord,
  versionId: string | null,
  definition: Record<string, unknown>,
  admission: RunAdmission & { outboxClaim: OutboxAdmissionClaim },
  triggerInput: unknown,
  options?: RunOptions,
): Promise<WorkflowRunOutcome | null>;
export async function runWorkflow(
  context: WorkflowEngineContext,
  dataPrincipal: DataPrincipal,
  workflow: WorkflowRecord,
  versionId: string | null,
  definition: Record<string, unknown>,
  admission: RunAdmission,
  triggerInput: unknown,
  options?: RunOptions,
): Promise<WorkflowRunOutcome>;
export async function runWorkflow(
  context: WorkflowEngineContext,
  dataPrincipal: DataPrincipal,
  workflow: WorkflowRecord,
  /** The live version row's id for a production run; null for a test run of the draft. */
  versionId: string | null,
  definition: Record<string, unknown>,
  admission: RunAdmission,
  triggerInput: unknown,
  options?: RunOptions,
): Promise<WorkflowRunOutcome | null> {
  const operations = ((definition.operations as DefinitionOperation[] | undefined) ?? []);
  const connections = ((definition.connections as DefinitionConnection[] | undefined) ?? []);
  const opsById = new Map(operations.map((op) => [op.id, op]));
  const findConnection = (source: string, output: string) => connections.find((c) => c.source === source && c.output === output);

  const start = operations.find((op) => op.type === "totalbase.start");
  if (!start) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "Workflow has no Start operation.");

  const [maxOperations, maxRunMs, maxPayloadBytes, maxIterationItems] = await Promise.all([
    context.settings.get("workflows.max_operations_per_run"),
    context.settings.get("workflows.max_run_duration_ms"),
    context.settings.get("workflows.max_history_payload_bytes"),
    context.settings.get("workflows.max_iteration_items"),
  ]);
  // Snapshotted once at admission (Specification_Workflows.md §9.1: "snapshotted per run") -
  // a later change to the workflow's own history settings never affects
  // an already-running/finished run's stored payloads.
  const historyPolicy: HistoryPolicy = { historyLevel: workflow.historyLevel, maxPayloadBytes };

  const principalDescriptor = { type: dataPrincipal.principal.type, id: dataPrincipal.principal.id };
  const initiator = admission.initiator ?? principalDescriptor;
  const runInput = {
    workflow: workflow.id,
    version: versionId,
    trigger: admission.trigger,
    mode: admission.mode,
    // Distinct for DATA_EVENT, CRON and WEBHOOK: what admitted this run, not
    // the account whose permissions the run itself executes under - see the
    // run table's own initiator/executor split.
    initiator,
    executor: principalDescriptor,
    historyEnabled: workflow.historyEnabled,
    historyLevel: workflow.historyLevel,
    expiresAt: new Date(Date.now() + maxRunMs),
  };
  const admitted = admission.outboxClaim
    ? await context.workflowRuns.createRunForOutboxEvent(runInput, admission.outboxClaim)
    : await context.workflowRuns.createRun(runInput);
  if (!admitted) return null; // an earlier attempt at this outbox event already admitted it.
  const run = admitted;
  // The deadline as stored (Specification_Workflows.md §8.5): no step starts after it.
  const deadline = new Date(run.expiresAt).getTime();
  const cancelToken: { cancelled: boolean; controller?: AbortController } = options?.cancelToken ?? { cancelled: false };
  cancelToken.controller ??= new AbortController();
  IN_PROCESS_RUNS.set(run.id, cancelToken);
  options?.onAdmitted?.(run);

  // The correlation every audit row a step writes carries (§7.4); `stepId` is set per step.
  const workflowContext: WorkflowRunContext = {
    workflowId: workflow.id,
    ancestry: admission.ancestry ?? [],
    runId: run.id,
    stepId: "",
    initiator,
    signal: cancelToken.controller.signal,
  };

  const state: RunState = { triggerData: triggerInput, results: new Map(), resultsByKey: new Map() };
  // Seeds `{{start.data...}}` (templates.ts) - Start is treated exactly
  // like any other operation from a template author's perspective, even
  // though `state.triggerData` itself deliberately stays unwrapped.
  state.resultsByKey.set("start", { data: triggerInput });
  const liveStepResults = new Map<string, unknown>();
  const liveStepErrors = new Map<string, { code: string; message: string }>();
  // Same live-override treatment as results/errors below - `runWorkflowTest`'s
  // own doc comment: the admin who clicked "Probar" sees the real,
  // unredacted values regardless of this workflow's own SUMMARY/DETAILED
  // history level, which never persists any payload at all in SUMMARY.
  const liveStepInputs = new Map<string, unknown>();
  // Threaded by reference through every recursive `walk()`/`runForEach()`
  // call (both root-scope and For each body-scope) so run history reads as
  // one flat, correctly-ordered sequence regardless of nesting.
  const cursor = { sequence: 1, predecessor: null as string | null };
  // Set once any step's failure is routed to its connected `error` output (§8.3).
  let hasHandledErrors = false;

  interface ScopeOutcome {
    status: WorkflowRunStatus;
    result: unknown;
    error?: { code: string; message: string };
  }

  /**
   * Checked at every step boundary (Specification_Workflows.md §8.5): a
   * cancellation request ends the run CANCELLED, a passed deadline ends it
   * INTERRUPTED - either way no further step starts.
   */
  function stopBeforeNextStep(): ScopeOutcome | undefined {
    if (cancelToken.cancelled) return { status: "CANCELLED", result: null };
    if (Date.now() > deadline) {
      return {
        status: "INTERRUPTED",
        result: null,
        error: { code: "WORKFLOW_LIMIT_EXCEEDED", message: `This run passed its deadline (workflows.max_run_duration_ms) and was stopped before its next step.` },
      };
    }
    return undefined;
  }
  const isStopped = (status: WorkflowRunStatus) => status === "CANCELLED" || status === "INTERRUPTED";

  /**
   * Shared engine for both loop-shaped control operations - `totalbase.for-each`
   * (Specification_Workflows.md §5.11: resolves `items`, walks the body once
   * per element) and `totalbase.process-batches` (§5.12: one body invocation
   * per fixed-size chunk). Both are sequential and fail-fast; completed
   * iterations' own effects are never rolled back. `state.currentItem`
   * exposes the current element/batch to `{{item...}}` inside the body for
   * the duration of that one iteration's walk - a single shared slot, since
   * nested loops are rejected at save time (one loop scope at a time).
   */
  async function runLoopOperation(
    node: DefinitionOperation,
    options: { sourceField: string; label: string; bodyOutput: "item" | "batch"; toIterationValues: (source: unknown[]) => unknown[] },
  ): Promise<{ output: string; result: unknown; error?: { code: string; message: string }; stopped?: ScopeOutcome }> {
    const fail = async (step: WorkflowRunStepRecord, err: { code: string; message: string }) => {
      liveStepErrors.set(step.id, err);
      await context.workflowRuns.finishStep(step.id, { status: "FAILED", selectedOutput: null, error: sanitizeError(err, historyPolicy) });
      const errorConnection = findConnection(node.id, "error");
      return errorConnection ? { output: "error", result: null, error: err } : { output: "__unhandled__", result: null, error: err };
    };

    // `items`/`source` is a literal JSON value with `{{...}}` support,
    // resolved here (For each/Process in batches never reach the generic
    // per-step branch) before the step is persisted, so `input` shows the
    // real resolved array.
    let resolvedSource: unknown;
    let templateError: { code: string; message: string } | undefined;
    try {
      resolvedSource = resolveTemplates(node.configuration[options.sourceField], state);
    } catch (templateResolutionError) {
      templateError = toStepError(templateResolutionError);
    }
    // `{{error...}}` is valid only while resolving this step's own configuration.
    state.currentError = undefined;
    const resolvedConfiguration = { ...node.configuration, [options.sourceField]: resolvedSource };

    const step = await context.workflowRuns.insertStep({
      run: run.id,
      operation: node.id,
      operationType: node.type,
      configurationVersion: node.configuration_version ?? 1,
      sequence: cursor.sequence,
      predecessor: cursor.predecessor,
      input: sanitizePayload(resolvedConfiguration, historyPolicy),
    });
    liveStepInputs.set(step.id, resolvedConfiguration);
    cursor.predecessor = step.id;

    if (templateError) return fail(step, templateError);
    const source = resolvedSource;
    if (!Array.isArray(source)) {
      return fail(step, { code: "WORKFLOW_INVALID_DESIGN", message: `${options.label} requires \`${options.sourceField}\` to resolve to an array.` });
    }
    if (source.length > maxIterationItems) {
      return fail(step, { code: "WORKFLOW_LIMIT_EXCEEDED", message: `${options.label} received ${source.length} items, exceeding the maximum of ${maxIterationItems} (workflows.max_iteration_items).` });
    }
    const iterationValues = options.toIterationValues(source);

    const bodyEntry = findConnection(node.id, options.bodyOutput)?.target;
    const results: unknown[] = [];
    const savedItem = state.currentItem;
    for (const value of iterationValues) {
      if (!bodyEntry) break; // empty/unwired body: the loop completes with no results.
      state.currentItem = value;
      cursor.sequence++;
      let iterationOutcome: ScopeOutcome;
      try {
        iterationOutcome = await walk(bodyEntry);
      } catch (bodyError) {
        // A body that throws (a limit, a broken connection) fails this step too - never left RUNNING.
        state.currentItem = savedItem;
        await fail(step, toStepError(bodyError));
        throw bodyError;
      }
      if (isStopped(iterationOutcome.status)) {
        state.currentItem = savedItem;
        // The loop step itself ends the way the run does - never left RUNNING.
        await context.workflowRuns.finishStep(step.id, { status: iterationOutcome.status as "CANCELLED" | "INTERRUPTED", selectedOutput: null });
        return { output: "__stopped__", result: null, stopped: iterationOutcome };
      }
      if (iterationOutcome.status === "FAILED") {
        state.currentItem = savedItem;
        return fail(step, iterationOutcome.error ?? { code: "INTERNAL_ERROR", message: `${options.label} body failed.` });
      }
      // Each iteration's terminal result arrives as `{ data: ... }` - the
      // collected array holds each completed body invocation's `data`.
      const iterationResult = iterationOutcome.result as { data?: unknown } | null;
      results.push(iterationResult && typeof iterationResult === "object" && "data" in iterationResult ? iterationResult.data : null);
    }
    state.currentItem = savedItem;

    const envelope = { data: results, meta: { count: results.length } };
    state.results.set(node.id, envelope);
    state.resultsByKey.set(node.key, envelope);
    liveStepResults.set(step.id, envelope);
    await context.workflowRuns.finishStep(step.id, { status: "SUCCEEDED", selectedOutput: "done", result: sanitizePayload(envelope, historyPolicy) });
    return { output: "done", result: envelope };
  }

  const runForEach = (node: DefinitionOperation) =>
    runLoopOperation(node, { sourceField: "items", label: "For each", bodyOutput: "item", toIterationValues: (v) => v });

  const runProcessBatches = (node: DefinitionOperation) => {
    const batchSize = Number(node.configuration.batchSize) || 50;
    return runLoopOperation(node, { sourceField: "source", label: "Process in batches", bodyOutput: "batch", toIterationValues: (v) => chunk(v, batchSize) });
  };

  /**
   * Walks one control-flow chain from `startId` until it dead-ends,
   * reaches a terminal operation, fails, or is stopped - used both for the
   * run's own root chain and, recursively, for a loop body's per-item
   * chain: a body terminal/dead-end only completes that item (§5.11) the
   * same way a root-scope one completes the whole run.
   *
   * A failure routed to a connected `error` output hands its
   * `{ code, message }` to the next step only (`incomingError` ->
   * `state.currentError`, `{{error...}}`), and marks the run as having
   * handled an error.
   */
  async function walk(startId: string): Promise<ScopeOutcome> {
    let currentId: string | undefined = startId;
    let incomingError: { code: string; message: string } | undefined;
    while (currentId) {
      const stop = stopBeforeNextStep();
      if (stop) return stop;
      if (cursor.sequence > maxOperations) {
        throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `This run exceeded the maximum of ${maxOperations} operations (workflows.max_operations_per_run).`);
      }
      const node = opsById.get(currentId);
      if (!node) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `A connection points at operation ${currentId}, which does not exist.`);
      state.currentError = incomingError;
      incomingError = undefined;

      if (node.type === "totalbase.for-each" || node.type === "totalbase.process-batches") {
        const outcome = node.type === "totalbase.for-each" ? await runForEach(node) : await runProcessBatches(node);
        if (outcome.stopped) return outcome.stopped;
        if (outcome.output === "__unhandled__") return { status: "FAILED", result: null, ...(outcome.error && { error: outcome.error }) };
        if (outcome.output === "error") {
          hasHandledErrors = true;
          incomingError = outcome.error;
        }
        const nextConnection = findConnection(node.id, outcome.output);
        if (!nextConnection) return { status: "SUCCEEDED", result: outcome.result };
        currentId = nextConnection.target;
        cursor.sequence++;
        continue;
      }

      const handler = OPERATION_HANDLERS[node.type];
      if (!handler) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Operation type "${node.type}" has no execution handler yet.`);

      // Resolved BEFORE insertStep, not inside the handler, so the
      // persisted `input` always holds the real values a step actually
      // used - a resolution failure (a bad {{...}} reference) is handled
      // exactly like a handler-thrown error below, just one step earlier.
      let resolvedConfiguration: Record<string, unknown> = node.configuration ?? {};
      let templateError: { code: string; message: string } | undefined;
      if (TEMPLATED_OPERATION_TYPES.has(node.type)) {
        try {
          resolvedConfiguration = resolveTemplates(node.configuration ?? {}, state) as Record<string, unknown>;
        } catch (templateResolutionError) {
          templateError = toStepError(templateResolutionError);
        }
      }
      state.currentError = undefined;

      const step = await context.workflowRuns.insertStep({
        run: run.id,
        operation: node.id,
        operationType: node.type,
        configurationVersion: node.configuration_version ?? 1,
        sequence: cursor.sequence,
        predecessor: cursor.predecessor,
        input: sanitizePayload(resolvedConfiguration, historyPolicy),
      });
      liveStepInputs.set(step.id, resolvedConfiguration);
      // Set as soon as the step exists: a walk's very last step (a
      // terminal, a dead end, or an unhandled error) is still the
      // predecessor of whatever runs next once this walk returns.
      cursor.predecessor = step.id;

      let outcome: OperationOutcome | undefined;
      let stepError: { code: string; message: string } | undefined = templateError;
      if (!stepError) {
        try {
          outcome = await handler({ context, dataPrincipal, configuration: resolvedConfiguration, state, workflowContext: { ...workflowContext, stepId: step.id } });
        } catch (handlerError) {
          stepError = toStepError(handlerError);
        }
      }

      if (stepError) {
        liveStepErrors.set(step.id, stepError);
        await context.workflowRuns.finishStep(step.id, { status: "FAILED", selectedOutput: null, error: sanitizeError(stepError, historyPolicy) });
        const errorConnection = findConnection(node.id, "error");
        if (errorConnection) {
          hasHandledErrors = true;
          incomingError = stepError;
          currentId = errorConnection.target;
          cursor.sequence++;
          continue;
        }
        return { status: "FAILED", result: null, error: stepError };
      }

      // "the engine wraps it in data" (§5.1) - applied here, once,
      // centrally; a handler returns whatever raw value is natural for it.
      const { output, result: rawResult } = outcome!;
      const stepResult = { data: rawResult };
      state.results.set(node.id, stepResult);
      state.resultsByKey.set(node.key, stepResult);
      liveStepResults.set(step.id, stepResult);
      await context.workflowRuns.finishStep(step.id, { status: "SUCCEEDED", selectedOutput: output, result: sanitizePayload(stepResult, historyPolicy) });

      if (TERMINAL_OPERATION_TYPES.has(node.type)) {
        return { status: node.type === "totalbase.finish-error" ? "FAILED" : "SUCCEEDED", result: stepResult };
      }

      const nextConnection = output ? findConnection(node.id, output) : undefined;
      if (!nextConnection) return { status: "SUCCEEDED", result: stepResult };
      currentId = nextConnection.target;
      cursor.sequence++;
    }
    return { status: "SUCCEEDED", result: null };
  }

  let status: WorkflowRunStatus = "SUCCEEDED";
  let result: unknown = null;
  let error: { code: string; message: string } | undefined;
  try {
    // Start is persisted as a real step too: `input` is the trigger's
    // configuration, `result` is `{ data: triggerInput }`.
    const startStep = await context.workflowRuns.insertStep({
      run: run.id,
      operation: start.id,
      operationType: start.type,
      configurationVersion: start.configuration_version ?? 1,
      sequence: cursor.sequence,
      predecessor: cursor.predecessor,
      input: sanitizePayload(start.configuration, historyPolicy),
    });
    liveStepInputs.set(startStep.id, start.configuration);
    const startResult = { data: triggerInput };
    liveStepResults.set(startStep.id, startResult);
    await context.workflowRuns.finishStep(startStep.id, { status: "SUCCEEDED", selectedOutput: "next", result: sanitizePayload(startResult, historyPolicy) });
    cursor.predecessor = startStep.id;
    cursor.sequence++;

    const rootStart = findConnection(start.id, "next")?.target;
    if (rootStart) {
      const outcome = await walk(rootStart);
      status = outcome.status;
      result = outcome.result;
      error = outcome.error;
    }
  } catch (runError) {
    status = "FAILED";
    error = toStepError(runError);
  } finally {
    IN_PROCESS_RUNS.delete(run.id);
    // The run's Execute JavaScript isolate (code-handlers.ts RunSandbox), however the run ended.
    state.sandbox?.dispose();
  }

  // Conditional on RUNNING: if recovery already marked the run INTERRUPTED,
  // that terminal status stands and this outcome is not recorded.
  const finished = await context.workflowRuns.finishRun(run.id, {
    status,
    result: sanitizePayload(result, historyPolicy),
    error: sanitizeError(error, historyPolicy),
    hasHandledErrors,
  });
  // Auto-disable tracking (§8.8): only a genuine SUCCEEDED/FAILED outcome
  // of a PRODUCTION run moves the streak; TEST, CANCELLED and INTERRUPTED
  // runs never do.
  if (finished && admission.mode === "PRODUCTION" && (status === "SUCCEEDED" || status === "FAILED")) {
    const autoDisableThreshold = await context.settings.get("workflows.auto_disable_after_consecutive_failures");
    await context.workflowsAdmin.recordRunOutcome(workflow.id, status, autoDisableThreshold);
  }
  const persistedSteps = await context.workflowRuns.listSteps(run.id);
  const persistedRun = await context.workflowRuns.getRun(run.id);

  const steps = persistedSteps.map((step) => ({
    ...step,
    input: (liveStepInputs.has(step.id) ? liveStepInputs.get(step.id) : step.input) ?? null,
    result: (liveStepResults.has(step.id) ? liveStepResults.get(step.id) : step.result) ?? null,
    error: (liveStepErrors.has(step.id) ? liveStepErrors.get(step.id) : step.error) ?? null,
  }));
  // Always present, null when there is none - the same shape a run read back later has.
  if (!finished) return { run: { ...persistedRun, result: persistedRun.result ?? null, error: persistedRun.error ?? null }, steps };
  return { run: { ...persistedRun, result: result ?? null, error: error ?? null }, steps };
}
