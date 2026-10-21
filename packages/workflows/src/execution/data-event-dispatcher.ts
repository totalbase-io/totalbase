import { randomUUID } from "node:crypto";
import type { WorkflowEngineContext } from "./context.js";
import { resolveDataPrincipalForConfiguredUser } from "./context.js";
import { buildRowFilter } from "@totalbase/mutations";
import { parseFilter, type FilterNode } from "@totalbase/query-engine";
import { recordSuppressedAdmission, runWorkflow } from "./engine.js";
import { evaluateFilter } from "./filter-evaluator.js";

interface OutboxRow {
  id: string;
  request_id: string;
  resource: string;
  event: "CREATE" | "UPDATE" | "DELETE" | "EXECUTE";
  payload: unknown;
  /** UPDATE: the row before the write - matched against `old_filter`, never passed to a run. */
  old_payload: Record<string, unknown> | null;
  /** UPDATE: the columns the write changed - matched against `changed_fields`. */
  changed_columns: string[] | null;
  status: string;
  /** Where the write came from (the audit log's source). */
  source: string;
  /** A workflow's write: its chain of workflow ids; NULL when that step opted out of emitting events. */
  workflow_ancestry: string[] | null;
}

/** One affected row of a write, with what its UPDATE changed. */
interface AffectedRow {
  row: Record<string, unknown>;
  old: Record<string, unknown> | null;
  changed: string[] | null;
  /** Its position - an admission claim's `item` in For each row. */
  item: number;
}

/**
 * The DATA_EVENT Start's own matching (Workflows.md §6.3.1),
 * on top of resource and kind: `filter` over the resulting row (the deleted
 * one on DELETE), and on an UPDATE `changed_fields` (one of them changed) and
 * `old_filter` (over the row before) - the one filter grammar, evaluated in
 * memory like a row filter. Admin-authored, so evaluated over the whole row;
 * what the run then receives is re-projected through the executor's READ.
 */
function startMatcher(config: Record<string, unknown>, event: OutboxRow["event"], limits: { maxFilterDepth: number; maxRelationDepth: number }) {
  const parse = (raw: unknown): FilterNode | undefined =>
    raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0 ? parseFilter(raw as Record<string, unknown>, limits, 0) : undefined;
  const filter = parse(config.filter);
  const oldFilter = event === "UPDATE" ? parse(config.old_filter) : undefined;
  const changedFields = event === "UPDATE" && Array.isArray(config.changed_fields) ? (config.changed_fields as string[]) : [];
  return (affected: AffectedRow): boolean => {
    if (filter && !evaluateFilter(filter, affected.row)) return false;
    if (oldFilter && !(affected.old && evaluateFilter(oldFilter, affected.old))) return false;
    if (changedFields.length > 0 && !(affected.changed ?? []).some((column) => changedFields.includes(column))) return false;
    return true;
  };
}

interface DefinitionOperation {
  id: string;
  type: string;
  configuration: Record<string, unknown>;
}

/**
 * Data-event admission (specs/Workflows.md §6.3):
 * the consumer side of `outbox`, which `enqueueOutboxEvent`
 * (@totalbase/outbox) has been writing into all along - `dispatchOutboxEventsEagerly`'s
 * doc comment in mutation-service.ts already named Workflow as this
 * table's intended consumer, this is that consumer, finally built.
 *
 * A workflow-sourced mutation (the outbox row's own `source = 'workflow'`,
 * written in the same transaction as the write - never the audit log,
 * which `audit.enabled` may switch off) only ever admits a further run
 * when the ORIGINATING Create/Update/Delete records step explicitly opted
 * in via its own `emitEvents` configuration field - carried as
 * `outbox.workflow_ancestry` (workflow-execution/handlers.ts's
 * `mutationDeps()`, mutation-service.ts's `AuditRequestContext.workflowAncestry`):
 * any other source means "not workflow-sourced at all" (admit normally,
 * starting a fresh chain); `workflow_ancestry: null` means "workflow-sourced
 * but opted out" (skip, same behavior this dispatcher always had before ancestry existed
 * at all); a real array is the chain of workflow ids that already ran
 * before this mutation, oldest first. Immutable causal ancestry
 * (Workflows.md §6.3.4) then rejects admitting a candidate workflow
 * whose own id already appears in that chain (a repeat = a loop), or
 * whose admission would make the chain longer than `workflows.max_chain_depth`.
 *
 * Delivery (Data_API.md §13.3, Workflows.md
 * §6.3.5): the event is claimed under a lease (`locked_until`, renewed
 * before each admission) so a stopped process's event is retried, and
 * every run - or suppression - it admits takes a claim in
 * `outbox_admissions`, so a retried event never admits one twice.
 */
export async function dispatchDataEvent(context: WorkflowEngineContext, outboxEventId: string): Promise<void> {
  const workerId = `data-event-${randomUUID()}`;
  const leaseSeconds = await context.settings.get("outbox.lease_seconds");
  // Claim (Data_API.md §13.3): PENDING -> PROCESSING under a
  // lease. SKIP LOCKED: a dispatcher racing for the same event moves on
  // instead of waiting for it.
  const { rows: claimed } = await context.database.query<OutboxRow>(
    `UPDATE totalbase.outbox
     SET status = 'PROCESSING', locked_at = now(), locked_by = $2, attempts = attempts + 1,
         locked_until = now() + make_interval(secs => $3)
     WHERE id = (SELECT id FROM totalbase.outbox WHERE id = $1 AND status = 'PENDING' FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [outboxEventId, workerId, leaseSeconds],
  );
  const outbox = claimed[0];
  if (!outbox) return; // already claimed/processed elsewhere - dispatch is at-least-once, this makes it idempotent.

  // Renews the lease before each admission, so a long dispatch (one run
  // per record, each awaited) keeps it while it is alive; a stopped
  // process stops renewing and the poller retries the event.
  const renewLease = async () => {
    await context.database.query(
      `UPDATE totalbase.outbox SET locked_until = now() + make_interval(secs => $3)
       WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
      [outboxEventId, workerId, leaseSeconds],
    );
  };

  // The final status applies only while this dispatcher still holds the
  // event: once its lease expired and the poller handed it on, the event
  // belongs to the next attempt.
  try {
    await dispatch(context, outbox, renewLease);
    await context.database.query(
      `UPDATE totalbase.outbox SET status = 'PROCESSED', processed_at = now(), locked_until = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
      [outboxEventId, workerId],
    );
  } catch (error) {
    context.logger.error({ error, outboxEventId }, "data-event dispatch failed");
    await context.database.query(
      `UPDATE totalbase.outbox SET status = 'FAILED', last_error = $3, locked_until = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
      [outboxEventId, workerId, error instanceof Error ? error.message : String(error)],
    );
  }
}

async function dispatch(context: WorkflowEngineContext, outbox: OutboxRow, renewLease: () => Promise<void>): Promise<void> {
  if (outbox.event === "EXECUTE") return; // DATA_EVENT Starts only match CREATE/UPDATE/DELETE (Workflows.md §6.3.1).

  // The event says where it came from itself (never the audit log, which audit.enabled may switch off).
  let incomingAncestry: string[] = [];
  if (outbox.source === "workflow") {
    if (outbox.workflow_ancestry == null) return; // that step's own emitEvents was unset at write time - opted out.
    incomingAncestry = outbox.workflow_ancestry;
  }

  // Most writes have no DATA_EVENT workflow to admit at all: one cached
  // EXISTS settles that before anything is loaded or parsed.
  if (!(await context.workflowsAdmin.hasEnabledPublishedDataEventStart())) return;

  const rows = Array.isArray(outbox.payload) ? (outbox.payload as Record<string, unknown>[]) : outbox.payload ? [outbox.payload as Record<string, unknown>] : [];
  if (rows.length === 0) return; // "zero affected records admits no run" (Workflows.md §6.3.3).
  const affectedRows: AffectedRow[] = rows.map((row, item) => ({ row, old: outbox.old_payload, changed: outbox.changed_columns, item }));

  // For each statement: every row the same write produced on this resource, in order - the
  // events of one request, one per row (Workflows.md §6.3.3). Its first event
  // admits the run; the others leave it to that one.
  let statement: { anchor: string; rows: AffectedRow[] } | null = null;
  const statementRows = async () => {
    if (statement) return statement;
    const { rows: group } = await context.database.query<OutboxRow>(
      `SELECT * FROM totalbase.outbox WHERE request_id = $1 AND resource = $2 AND event = $3 ORDER BY created_at, id`,
      [outbox.request_id, outbox.resource, outbox.event],
    );
    statement = {
      anchor: group[0]?.id ?? outbox.id,
      rows: group.flatMap((event) => (Array.isArray(event.payload) ? event.payload : [event.payload]).filter(Boolean)
        .map((row) => ({ row: row as Record<string, unknown>, old: event.old_payload, changed: event.changed_columns, item: 0 }))),
    };
    return statement;
  };

  // Only the workflows whose live Start is a DATA_EVENT on this resource (PostgreSQL filters the published JSON).
  const candidates = await context.workflowsAdmin.listEnabledPublishedByStart({ trigger: "DATA_EVENT", resource: outbox.resource });
  const [maxFilterDepth, maxRelationDepth, maxRuntimeBytes, maxChainDepth] = await Promise.all([
    context.settings.get("api.max_filter_depth"),
    context.settings.get("api.max_relation_depth"),
    context.settings.get("workflows.max_runtime_value_bytes"),
    context.settings.get("workflows.max_chain_depth"),
  ]);
  const limits = { maxFilterDepth, maxRelationDepth };

  for (const { workflow, definition } of candidates) {
    const start = ((definition.operations as DefinitionOperation[] | undefined) ?? []).find((op) => op.type === "totalbase.start");
    const config = start?.configuration ?? {};
    if (config.trigger !== "DATA_EVENT") continue;
    if (config.resource !== outbox.resource) continue;
    const events = (config.events as string[] | undefined) ?? [];
    if (!events.includes(outbox.event)) continue;
    const perStatement = config.for_each === "STATEMENT";
    if (perStatement && (await statementRows()).anchor !== outbox.id) continue; // the write's first event admits it
    let matches: (affected: AffectedRow) => boolean;
    try {
      matches = startMatcher(config, outbox.event, limits);
    } catch (error) {
      context.logger.warn({ error, workflowId: workflow.id }, "DATA_EVENT workflow's Start filter is invalid, admission skipped");
      continue;
    }

    const initiator = { type: "DATA_EVENT", resource: outbox.resource, event: outbox.event, requestId: outbox.request_id, ...(perStatement && { forEach: "STATEMENT" }) };
    // Every run this event admits for this workflow - or the one
    // suppression it records - takes a claim, so a retried event never
    // admits it twice (Workflows.md §6.3.5).
    const workflowClaim = { event: outbox.id, item: null };
    await renewLease();

    if (incomingAncestry.includes(workflow.id)) {
      context.logger.warn({ workflowId: workflow.id, ancestry: incomingAncestry }, "causal-ancestry loop detected, admission suppressed");
      await recordSuppressedAdmission(context, workflow, definition, { trigger: "DATA_EVENT", initiator, outboxClaim: workflowClaim }, { code: "WORKFLOW_INVALID_DESIGN", message: "This workflow's own id already appears earlier in this admission's causal-ancestry chain (a loop)." });
      continue;
    }
    // The chain - the ancestry plus this candidate - holds at most
    // workflows.max_chain_depth workflows (Workflows.md §6.3.4).
    if (incomingAncestry.length >= maxChainDepth) {
      context.logger.warn({ workflowId: workflow.id, ancestry: incomingAncestry }, "causal-ancestry chain depth exceeded, admission suppressed");
      await recordSuppressedAdmission(context, workflow, definition, { trigger: "DATA_EVENT", initiator, outboxClaim: workflowClaim }, { code: "WORKFLOW_LIMIT_EXCEEDED", message: `This admission's causal-ancestry chain would exceed the maximum depth of ${maxChainDepth} (workflows.max_chain_depth).` });
      continue;
    }

    const executeAs = config.execute_as as string | undefined;
    if (!executeAs) {
      context.logger.warn({ workflowId: workflow.id }, "DATA_EVENT workflow has no execute_as configured, skipping admission");
      await recordSuppressedAdmission(context, workflow, definition, { trigger: "DATA_EVENT", initiator, outboxClaim: workflowClaim }, { code: "WORKFLOW_INVALID_DESIGN", message: "This workflow has no execution user (execute_as) configured." });
      continue;
    }

    let executor;
    try {
      executor = await resolveDataPrincipalForConfiguredUser(context, executeAs);
    } catch (error) {
      context.logger.warn({ error, workflowId: workflow.id }, "DATA_EVENT workflow's execute_as user could not be resolved, skipping admission");
      await recordSuppressedAdmission(context, workflow, definition, { trigger: "DATA_EVENT", initiator, outboxClaim: workflowClaim }, { code: "WORKFLOW_INVALID_DESIGN", message: `This workflow's execution user could not be resolved: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    const permission = await context.effectivePermissions.resolve(executor.roleIds, outbox.resource, "READ");
    if (permission.action !== "ALLOW") continue; // execute_as can't read this resource at all - no rows survive.
    const rowFilter = buildRowFilter(permission, limits);

    // Re-project through execute_as's OWN current permissions at
    // admission time - never trust the write-time projection
    // (Workflows.md §6.3.3: "never bypasses field or row permissions merely because the
    // initiating write was allowed").
    // Each record keeps its position in the event's payload - its
    // admission claim's `item`, stable across retries.
    const candidatesRows = perStatement ? (await statementRows()).rows : affectedRows;
    const projected = candidatesRows
      .filter(matches)
      .map(({ row, item }) => ({ row, item }))
      .filter(({ row }) => !rowFilter || evaluateFilter(rowFilter, row))
      .map(({ row, item }) => {
        const visible: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(row)) {
          if (permission.fieldDecision(field) === "ALLOW") visible[field] = value;
        }
        return { row: visible, item };
      })
      .filter(({ row }) => Object.keys(row).length > 0);

    // For each statement: one run, its input the list of rows (none surviving: no run).
    if (perStatement) {
      if (projected.length === 0) continue;
      await renewLease();
      const list = projected.map(({ row }) => row);
      const size = Buffer.byteLength(JSON.stringify(list), "utf8");
      if (size > maxRuntimeBytes) {
        await recordSuppressedAdmission(context, workflow, definition, { trigger: "DATA_EVENT", initiator, executor: { type: executor.principal.type, id: executor.principal.id }, outboxClaim: workflowClaim }, { code: "WORKFLOW_LIMIT_EXCEEDED", message: `This write's rows (${size} bytes) exceed the maximum trigger payload size of ${maxRuntimeBytes} bytes (workflows.max_runtime_value_bytes).` });
        continue;
      }
      await runWorkflow(context, executor, workflow, workflow.publishedVersion!, definition, { trigger: "DATA_EVENT", mode: "PRODUCTION", initiator, ancestry: incomingAncestry, outboxClaim: workflowClaim }, list);
      continue;
    }

    for (const { row, item } of projected) {
      await renewLease();
      const outboxClaim = { event: outbox.id, item };
      const size = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (size > maxRuntimeBytes) {
        context.logger.warn({ workflowId: workflow.id, size, maxRuntimeBytes }, "Data-event admission skipped: the record exceeds workflows.max_runtime_value_bytes");
        await recordSuppressedAdmission(context, workflow, definition, { trigger: "DATA_EVENT", initiator, executor: { type: executor.principal.type, id: executor.principal.id }, outboxClaim }, { code: "WORKFLOW_LIMIT_EXCEEDED", message: `This record's own size (${size} bytes) exceeds the maximum trigger payload size of ${maxRuntimeBytes} bytes (workflows.max_runtime_value_bytes).` });
        continue;
      }
      await runWorkflow(
        context,
        executor,
        workflow,
        workflow.publishedVersion!,
        definition,
        {
          trigger: "DATA_EVENT",
          mode: "PRODUCTION",
          initiator,
          ancestry: incomingAncestry,
          outboxClaim,
        },
        row,
      );
    }
  }
}
