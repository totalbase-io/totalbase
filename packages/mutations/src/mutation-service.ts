import { buildUpdateChanges, withoutExcludedFields, type AuditLogEntry, type AuditWriteAction } from "@totalbase/audit";
import type { Queryable } from "@totalbase/database";
import { TotalBaseError, deniedMessage } from "@totalbase/errors";
import type { EffectivePermission, ResourceAction } from "@totalbase/permissions";
import {
  compileDelete,
  compileInsert,
  compileInsertMany,
  compileRowExists,
  compileUpdate,
  preloadRelations,
  relatedResolver,
  ROW_VERSION_COLUMN,
  SchemaContext,
  parseFilter,
  type CompiledMutation,
  type FilterNode,
  type MutationCompileContext,
  type OnConflictSpec,
  type PayloadCheckColumn,
  type PayloadCheckRule,
} from "@totalbase/query-engine";
import type { ResolvedResource } from "@totalbase/query-engine";
import { enqueueOutboxEvents, type OutboxEventInput } from "@totalbase/outbox";
import { writeTransactionContext, type DataPrincipal, type MutationsContext } from "./context.js";
import {
  assertRolesDeleteAllowed,
  assertAdminWrittenTable,
  assertNotSettingsWrite,
  assertAssignmentDeleteAllowed,
  assertRoleOwnership,
  accessEventFor,
  resolveWriteCaller,
  assertGuardedColumnsWriteAllowed,
  assertUserRoleAssignmentAllowed,
  isProtectedField,
  protectedFieldDecision,
  withoutProtectedFields,
} from "./totalbase-guardrails.js";
import { hashPasswordFields, loadPasswordColumns, stripPasswordFields } from "./password-fields.js";
import { mutationResponseProjection } from "./response-projection.js";

export interface Limits {
  maxFilterDepth: number;
  maxRelationDepth: number;
}

export function userVariableResolver(dataPrincipal: DataPrincipal) {
  return (field: string): unknown => {
    if (!dataPrincipal.userRow) {
      throw new TotalBaseError("INVALID_QUERY", "$USER.* is not available for this principal.");
    }
    // A protected column (password_hash) is never readable through the Data
    // API - not even compared against in a filter, which would leak it one
    // comparison at a time. Same message as an unknown field.
    if (!(field in dataPrincipal.userRow) || isProtectedField("totalbase", "users", field)) {
      throw new TotalBaseError("INVALID_QUERY", `Unknown $USER field: ${field}`);
    }
    return dataPrincipal.userRow[field];
  };
}

/** OR-combines every ALLOW grant's where_clause (Security.md §6.5). undefined = unrestricted. */
export function buildRowFilter(permission: EffectivePermission, limits: Limits): FilterNode | undefined {
  const sources = permission.rowFilterSources;
  if (!sources || sources.length === 0) return undefined;
  const clauses: FilterNode[] = [];
  for (const source of sources) {
    if (source.whereClause === null || source.whereClause === undefined) return undefined;
    clauses.push(parseFilter(source.whereClause, limits, 0));
  }
  return clauses.length === 1 ? clauses[0]! : { type: "or", children: clauses };
}

/**
 * Every ALLOW grant's "Payload checks" (see totalbase.permissions.
 * payload_checks' column comment) - unlike buildRowFilter, these are kept
 * as a flat list, not combined into one FilterNode: compileInsert/
 * compileUpdate append one SQL flag per check (AND semantics - every
 * check must pass) so a failure can be reported by that specific
 * check's label, not just "something failed".
 */
export function buildPayloadChecks(permission: EffectivePermission, limits: Limits): PayloadCheckRule[] | undefined {
  const sources = permission.payloadCheckSources;
  if (!sources) return undefined;
  return sources.map((source) => ({ rule: parseFilter(source.rule, limits, 0), label: source.label }));
}

/** Every write path (single, bulk, nested, transaction) resolves its permission here - the access-table guardrail rides along. */
export async function resolvePermissionOrThrow(
  context: MutationsContext,
  dataPrincipal: DataPrincipal,
  root: ResolvedResource,
  resourceId: string,
  action: ResourceAction,
): Promise<EffectivePermission> {
  await assertAdminWrittenTable((roleIds) => context.effectivePermissions.isAdministrators(roleIds), dataPrincipal.roleIds, root);
  assertNotSettingsWrite(root);
  const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resourceId, action);
  if (permission.action !== "ALLOW") {
    throw new TotalBaseError("ACTION_DENIED", deniedMessage(action, root.schema, root.table));
  }
  return permission;
}

/** Row filter check (Security.md §6.6 "authorize NEW") - checked first; a permission-scoped rejection outranks a business-rule one. */
export async function assertAuthorizedRow(row: Record<string, unknown>, action: ResourceAction): Promise<void> {
  if (row["__authorized"] === false) {
    throw new TotalBaseError(
      "ACTION_DENIED",
      `The row does not satisfy the effective permission filter after this ${action}.`,
    );
  }
}

/**
 * "Payload checks" check - every __payload_check_N column
 * compileInsert/compileUpdate appended (one per check) must be true.
 * Reports every failing check's label in one message (not just the
 * first), joined with "; "; a check with no label falls back to its raw
 * JSON so the failure is never silent even when nobody wrote a friendly
 * message for it.
 */
export function assertValidRow(row: Record<string, unknown>, payloadCheckColumns: PayloadCheckColumn[]): void {
  const failed = payloadCheckColumns.filter((c) => row[c.column] === false);
  if (failed.length === 0) return;
  throw new TotalBaseError(
    "PAYLOAD_CHECK_FAILED",
    failed.map((c) => c.label ?? "A payload check was not satisfied.").join("; "),
  );
}

export function stripInternal(row: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...row };
  delete clean["__authorized"];
  delete clean["__inserted"];
  delete clean[ROW_VERSION_COLUMN];
  for (const key of Object.keys(clean)) {
    if (key.startsWith("__payload_check_") || key.startsWith("__old_")) delete clean[key];
  }
  return clean;
}

/**
 * The columns whose values before an UPDATE compileUpdate returns: every one
 * (Security.md §11.4) - the audit records old and new of each
 * column the update changed, and the outbox event carries the row before it
 * for a DATA_EVENT Start. Exclusions and protected columns are dropped
 * later, from the audit entry only.
 */
export function updateOldValueFields(deps: MutationDeps): string[] {
  return deps.root.columns.map((column) => column.name);
}

/**
 * The row as it was before an UPDATE, from the __old_N columns compileUpdate
 * returned (Password columns never). undefined when it returned none (a
 * table without a primary key on PostgreSQL 15-17).
 */
export function oldRowOf(
  row: Record<string, unknown>,
  compiled: CompiledMutation,
  passwordColumns: Set<string>,
): Record<string, unknown> | undefined {
  if (compiled.oldValueColumns.length === 0) return undefined;
  const old: Record<string, unknown> = {};
  for (const { column, field } of compiled.oldValueColumns) old[field] = row[column];
  return stripPasswordFields(old, passwordColumns);
}

/** The row's primary key columns - what an audit entry always keeps. */
function primaryKeyOf(root: MutationDeps["root"], row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(root.primaryKey.filter((field) => field in row).map((field) => [field, row[field]]));
}

/** Request-scoped metadata needed for audit_logs / outbox_events (Security.md §11.2, Data_API.md §13). */
export interface AuditRequestContext {
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  source: string;
  /**
   * Causal-ancestry chain for a workflow-sourced mutation (Workflows.md §6.3.4) -
   * `undefined` for an ordinary Data API mutation (not workflow-sourced at
   * all), `null` for a workflow-sourced one whose own Create/Update/Delete
   * records step has `emitEvents` unset (the default - no downstream
   * DATA_EVENT admission permitted), or the real chain (this workflow's
   * own incoming ancestry plus itself) when that one step opted in. Stored
   * in `logs.metadata`
   * (see workflow-execution/handlers.ts's own `mutationDeps()`) -
   * deliberately reusing that already-provisioned, previously unused jsonb
   * column rather than adding a new one, since nothing else needs
   * `metadata` yet.
   */
  workflowAncestry?: string[] | null;
  /**
   * A workflow step's correlation (Workflows.md §7.4) -
   * `workflow`, `workflowRun`, `workflowStep`, `workflowInitiator` - merged
   * into `logs.metadata`. Set by the workflow engine only.
   */
  workflowCorrelation?: Record<string, unknown>;
}

export interface MutationDeps {
  context: MutationsContext;
  dataPrincipal: DataPrincipal;
  resourceId: string;
  root: ResolvedResource;
  limits: Limits;
  audit: AuditRequestContext;
}

/**
 * Writes the audit_logs row and enqueues the matching outbox_event for one
 * successfully mutated row, using the SAME transaction client as the
 * mutation itself (Data_API.md §13.1: "business mutation + audit + outbox event
 * = same transaction").
 */
function auditMetadata(deps: MutationDeps, action: AuditWriteAction): Record<string, unknown> | undefined {
  const event = accessEventFor(deps.root, action);
  if (deps.audit.workflowAncestry === undefined && deps.audit.workflowCorrelation === undefined && event === undefined) return undefined;
  return {
    ...deps.audit.workflowCorrelation,
    ...(deps.audit.workflowAncestry !== undefined && { workflowAncestry: deps.audit.workflowAncestry }),
    ...(event !== undefined && { event }),
  };
}

/**
 * The audit rows and outbox events one operation writes, flushed in two
 * statements at the end of its loop - a bulk CREATE's
 * items, a PATCH's matched rows - instead of two round trips per row while
 * the locks are held. The resource's audit exclusions are read once per
 * batch, on the transaction's own client.
 */
export interface WriteBatch {
  audits: AuditLogEntry[];
  outbox: OutboxEventInput[];
  excluded?: Set<string>;
}

export function newWriteBatch(): WriteBatch {
  return { audits: [], outbox: [] };
}

/** Builds one row's audit entry and outbox event and adds them to `batch` - nothing is written until flushWriteBatch. */
export async function queueAuditAndOutbox(
  deps: MutationDeps,
  client: Queryable,
  action: AuditWriteAction,
  startedAt: Date,
  oldRow: Record<string, unknown> | undefined,
  newRow: Record<string, unknown> | undefined,
  batch: WriteBatch,
): Promise<void> {
  // Protected columns (password_hash, token_hash, key_hash, ...) never reach
  // the audit log or the outbox - both are readable data (logs
  // through the Data API, events through webhooks). Password columns are
  // already stripped by the caller.
  oldRow = withoutProtectedFields(deps.root, oldRow);
  newRow = withoutProtectedFields(deps.root, newRow);
  // Audited whole by default (Security.md §11.4): the row in
  // `payload`, and an UPDATE's old/new of every column it changed in
  // `changes` - minus the columns the administrator excluded, from both.
  // The outbox event below keeps the whole row: a workflow needs its data.
  // On this transaction's client - a second connection borrowed while this one is held starves the pool under load.
  batch.excluded ??= await deps.context.auditExclusions.excludedFields(deps.resourceId, client);
  const excluded = batch.excluded;
  const payload = newRow ?? oldRow ?? {};
  const changes = action === "UPDATE" ? buildUpdateChanges(oldRow, newRow, excluded) : undefined;
  // The excluded columns never include the primary key's in practice, but
  // the entry keeps it regardless: a row's history ("View history") filters
  // on `payload ->> pkColumn`.
  const auditPayload = { ...withoutExcludedFields(payload, excluded), ...primaryKeyOf(deps.root, payload) };
  batch.audits.push({
    requestId: deps.audit.requestId,
    principal: deps.dataPrincipal.principal,
    resourceId: deps.resourceId,
    action,
    status: "EXECUTED",
    source: deps.audit.source,
    ip: deps.audit.ip,
    userAgent: deps.audit.userAgent,
    payload: auditPayload,
    changes,
    // See AuditRequestContext.workflowAncestry's own doc comment - `undefined`
    // (an ordinary, non-workflow mutation) leaves `metadata` unset entirely.
    // A write on an access table also names its event (accessEventFor).
    metadata: auditMetadata(deps, action),
    startedAt,
    finishedAt: new Date(),
  });
  batch.outbox.push({
    requestId: deps.audit.requestId,
    resource: deps.resourceId,
    event: action,
    payload,
    source: deps.audit.source,
    // The event itself says it is a workflow's write - the dispatcher never consults the audit log for it (which audit.enabled may switch off).
    ...(deps.audit.workflowAncestry !== undefined && { workflowAncestry: deps.audit.workflowAncestry }),
    // An UPDATE also carries the row before it and what changed - a DATA_EVENT Start matches on them.
    ...(action === "UPDATE" && oldRow && newRow && {
      oldPayload: oldRow,
      changedColumns: Object.keys(newRow).filter((column) => JSON.stringify(newRow[column]) !== JSON.stringify(oldRow[column])),
    }),
  });
}

/** Writes the batch - one INSERT for the audit rows, one for the outbox events - on the transaction's client; returns the outbox ids in order. */
export async function flushWriteBatch(context: MutationsContext, client: Queryable, batch: WriteBatch): Promise<string[]> {
  if (batch.outbox.length === 0) return [];
  await context.audit.recordMany(client, batch.audits);
  const ids = await enqueueOutboxEvents(client, batch.outbox);
  batch.audits = [];
  batch.outbox = [];
  return ids;
}

/**
 * The same for one row, written at once - a transaction's or a nested
 * write's node, which audit as they go.
 */
export async function auditAndEnqueue(
  deps: MutationDeps,
  client: Queryable,
  action: AuditWriteAction,
  startedAt: Date,
  oldRow: Record<string, unknown> | undefined,
  newRow: Record<string, unknown> | undefined,
): Promise<string> {
  const batch = newWriteBatch();
  await queueAuditAndOutbox(deps, client, action, startedAt, oldRow, newRow, batch);
  return (await flushWriteBatch(deps.context, client, batch))[0]!;
}

/**
 * Eager dispatch hook: right after a mutation's transaction commits, this
 * is where a consumer gets first crack at the outbox rows just enqueued -
 * fire-and-forget, never awaited on the response path, so a caller's
 * request latency/success never depends on what a consumer does with the
 * event. `context.dispatchWorkflowDataEvent` (wired in context.ts, backed
 * by workflow-execution/data-event-dispatcher.ts) is that consumer -
 * indirected through `MutationsContext` rather than importing the dispatcher
 * module directly here to avoid a circular import (the dispatcher itself
 * needs `buildRowFilter` from this very file). A background poller
 * (apps/server/src/index.ts) re-scans PENDING rows on a fixed interval as
 * a fallback for whatever this eager path misses (a crash between commit
 * and dispatch, a transient failure) - eager dispatch is a latency
 * optimization, not the only path an event can be processed through.
 */
export function dispatchOutboxEventsEagerly(context: MutationsContext, outboxEventIds: string[]): void {
  for (const id of outboxEventIds) {
    context.dispatchWorkflowDataEvent(id);
  }
}

/**
 * Best-effort audit entry for a mutation that never committed (permission
 * denied before the transaction opened, or the transaction itself rolled
 * back) - written on a fresh connection since the failed transaction's
 * own connection has already rolled back.
 */
export async function recordMutationFailure(
  deps: MutationDeps,
  action: AuditWriteAction,
  status: "DENIED" | "FAILED",
  startedAt: Date,
  error: unknown,
): Promise<void> {
  try {
    const detail =
      error instanceof TotalBaseError
        ? { code: error.code, sqlstate: error.sqlstate, message: error.message, detail: error.detail, hint: error.hint }
        : { message: error instanceof Error ? error.message : String(error) };
    await deps.context.audit.record(deps.context.database, {
      requestId: deps.audit.requestId,
      principal: deps.dataPrincipal.principal,
      resourceId: deps.resourceId,
      action,
      status,
      source: deps.audit.source,
      ip: deps.audit.ip,
      userAgent: deps.audit.userAgent,
      ...(deps.audit.workflowCorrelation !== undefined && { metadata: deps.audit.workflowCorrelation }),
      error: detail,
      startedAt,
      finishedAt: new Date(),
    });
  } catch {
    // Audit logging must never mask or replace the original error.
  }
}

function isInsertReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("$INSERT.");
}

/** on_conflict.data's literal values (not its `$INSERT.<field>` references, which read the item's own hashed values). */
function conflictLiterals(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => !isInsertReference(value)));
}

/** What the DO UPDATE branch writes for one item: each `$INSERT.<field>` read from the item (absent: the column's default). */
function conflictValuesFor(data: Record<string, unknown>, item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([field, value]) => [field, isInsertReference(value) ? item[value.slice("$INSERT.".length)] : value]),
  );
}

/**
 * Executes one or many CREATE items in a single transaction; any failure rolls back all of them.
 *
 * `on_conflict` action UPDATE makes each item an upsert (Data_API.md §5.7):
 * it needs the UPDATE grant as well as CREATE, and each row is authorized,
 * checked and audited as what it became - an inserted row as a CREATE, an
 * existing row the conflict updated as an UPDATE (its old values read in
 * the same statement). An existing row the UPDATE row
 * filter excludes is left untouched and fails the request with ACTION_DENIED.
 *
 * One result per item, in order: the created (or upserted) row, or `null` for
 * an item `on_conflict` NOTHING skipped - so a bulk response stays aligned with
 * its request.
 */
/** The one field set every item carries (same keys, any order) - or null when they differ or there are none. */
function uniformFields(items: Record<string, unknown>[]): string[] | null {
  const first = items[0];
  if (!first) return null;
  const fields = Object.keys(first).sort();
  if (fields.length === 0) return null;
  const key = fields.join("\u0000");
  return items.every((item) => Object.keys(item).sort().join("\u0000") === key) ? fields : null;
}

export async function executeCreate(
  deps: MutationDeps,
  items: Record<string, unknown>[],
  onConflict: OnConflictSpec | undefined,
): Promise<(Record<string, unknown> | null)[]> {
  const startedAt = new Date();
  const upsert = onConflict?.action === "UPDATE";
  let permission: EffectivePermission;
  let updatePermission: EffectivePermission | undefined;
  try {
    permission = await resolvePermissionOrThrow(deps.context, deps.dataPrincipal, deps.root, deps.resourceId, "CREATE");
  } catch (error) {
    await recordMutationFailure(deps, "CREATE", "DENIED", startedAt, error);
    throw error;
  }
  if (upsert) {
    try {
      updatePermission = await resolvePermissionOrThrow(deps.context, deps.dataPrincipal, deps.root, deps.resourceId, "UPDATE");
    } catch (error) {
      await recordMutationFailure(deps, "UPDATE", "DENIED", startedAt, error);
      throw error;
    }
  }
  const rowFilter = buildRowFilter(permission, deps.limits);
  const payloadChecks = buildPayloadChecks(permission, deps.limits);
  const mutationContext: MutationCompileContext = {
    root: deps.root,
    fieldDecision: protectedFieldDecision(deps.root, permission.fieldDecision),
    rowFilter,
    payloadChecks,
    resolveUserVariable: userVariableResolver(deps.dataPrincipal),
    // The grant's row filter and payload checks may follow foreign keys (Security.md §6.5).
    related: relatedResolver(new SchemaContext(deps.context.database)),
    ...(updatePermission && {
      conflictUpdate: {
        fieldDecision: protectedFieldDecision(deps.root, updatePermission.fieldDecision),
        rowFilter: buildRowFilter(updatePermission, deps.limits),
        payloadChecks: buildPayloadChecks(updatePermission, deps.limits),
      },
    }),
  };
  // Before BEGIN: the tables its filters reach are read through the pool now, never inside the transaction.
  await preloadRelations(mutationContext);
  const passwordColumns = await loadPasswordColumns(deps.context, deps.resourceId);
  const project = await mutationResponseProjection(deps.context, deps.dataPrincipal, deps.root, deps.resourceId, passwordColumns);
  const caller = await resolveWriteCaller((ids) => deps.context.effectivePermissions.isAdministrators(ids), deps.dataPrincipal);
  const oldValueFields = upsert ? updateOldValueFields(deps) : undefined;

  const outboxEventIds: string[] = [];
  try {
    const results = await deps.context.database.transaction(async (client: Queryable) => {
      // The DO UPDATE branch's literal values are hashed like an UPDATE's data.
      let conflict = onConflict;
      if (onConflict?.action === "UPDATE") {
        const hashed = await hashPasswordFields(deps.context, passwordColumns, conflictLiterals(onConflict.data ?? {}));
        conflict = { ...onConflict, data: { ...onConflict.data, ...hashed } };
      }
      const results: (Record<string, unknown> | null)[] = [];
      const batch = newWriteBatch();
      // Items sharing one field set, with no on_conflict: one INSERT over them all; otherwise one per item.
      const fields = uniformFields(items);
      if (!onConflict && fields && items.length > 1) {
        const hashedItems: Record<string, unknown>[] = [];
        for (const item of items) {
          assertGuardedColumnsWriteAllowed(deps.root, item, caller);
          await assertUserRoleAssignmentAllowed(client, deps.root, item, caller);
          hashedItems.push(await hashPasswordFields(deps.context, passwordColumns, item));
        }
        const compiled = await compileInsertMany(mutationContext, fields, hashedItems);
        const { rows } = await client.query(compiled.sql, compiled.params);
        if (rows.length !== items.length) throw new TotalBaseError("INTERNAL_ERROR", `Bulk create returned ${rows.length} rows for ${items.length} items.`);
        for (const row of rows as Record<string, unknown>[]) {
          await assertAuthorizedRow(row, "CREATE");
          assertValidRow(row, compiled.payloadCheckColumns);
          const clean = stripPasswordFields(stripInternal(row), passwordColumns);
          await queueAuditAndOutbox(deps, client, "CREATE", startedAt, undefined, clean, batch);
          results.push(project(clean));
        }
        outboxEventIds.push(...(await flushWriteBatch(deps.context, client, batch)));
        return results;
      }
      for (const item of items) {
        if (onConflict?.action === "UPDATE") {
          // The DO UPDATE branch passes the guardrails a plain UPDATE's data does - every column it sets,
          // whether a literal or `$INSERT.<field>` (a reference to a column the item leaves out still writes its default).
          const conflictValues = conflictValuesFor(onConflict.data ?? {}, item);
          assertGuardedColumnsWriteAllowed(deps.root, conflictValues, caller);
          await assertUserRoleAssignmentAllowed(client, deps.root, conflictValues, caller);
        }
        assertGuardedColumnsWriteAllowed(deps.root, item, caller);
        await assertUserRoleAssignmentAllowed(client, deps.root, item, caller);
        const hashedItem = await hashPasswordFields(deps.context, passwordColumns, item);
        const compiled = await compileInsert(mutationContext, hashedItem, conflict, oldValueFields);
        const { rows } = await client.query(compiled.sql, compiled.params);
        if (compiled.insertedColumn && rows.length === 0) {
          // The row conflicts with an existing one the UPDATE row filter excludes - PostgreSQL left it untouched.
          throw new TotalBaseError("ACTION_DENIED", "The existing row this write conflicts with may not be updated.");
        }
        // DO NOTHING skipped this item: no row, no audit, no outbox event.
        if (rows.length === 0) results.push(null);
        for (const row of rows as Record<string, unknown>[]) {
          const action = compiled.insertedColumn && row[compiled.insertedColumn] === false ? "UPDATE" : "CREATE";
          await assertAuthorizedRow(row, action);
          assertValidRow(row, compiled.payloadCheckColumns);
          if (action === "UPDATE") assertRoleOwnership(deps.root, row, caller);
          const clean = stripPasswordFields(stripInternal(row), passwordColumns);
          const oldRow = action === "UPDATE" ? oldRowOf(row, compiled, passwordColumns) : undefined;
          await queueAuditAndOutbox(deps, client, action, startedAt, oldRow, clean, batch);
          results.push(project(clean));
        }
      }
      outboxEventIds.push(...(await flushWriteBatch(deps.context, client, batch)));
      return results;
    }, await writeTransactionContext(deps.context, deps.dataPrincipal));
    dispatchOutboxEventsEagerly(deps.context, outboxEventIds);
    return results;
  } catch (error) {
    await recordMutationFailure(deps, "CREATE", "FAILED", startedAt, error);
    throw error;
  }
}

/**
 * A write under If-Match matched nothing: the row is there for this caller but written since they read it -
 * 409 ROW_VERSION_CONFLICT - or it isn't (gone, or hidden by their row filter), which stays the caller's 404 (T56).
 */
async function assertNotStale(client: Queryable, context: MutationCompileContext, where: FilterNode): Promise<void> {
  const exists = await compileRowExists(context, where);
  const { rows } = await client.query(exists.sql, exists.params);
  if (rows.length > 0) {
    throw new TotalBaseError("ROW_VERSION_CONFLICT", "This record was changed by someone else since it was read - reload it, or save again to overwrite.");
  }
}

/** Executes one or many UPDATE operations in a single transaction; any failure rolls back all of them. */
export async function executeUpdate(
  deps: MutationDeps,
  operations: { data: Record<string, unknown>; where: FilterNode | undefined; version?: string | undefined }[],
  requireAtLeastOneRow: boolean,
  /** Filled with each written row's new version (xmin), in order - for a by-key write's response (T56). */
  versions?: string[],
): Promise<Record<string, unknown>[]> {
  const startedAt = new Date();
  let permission: EffectivePermission;
  try {
    permission = await resolvePermissionOrThrow(deps.context, deps.dataPrincipal, deps.root, deps.resourceId, "UPDATE");
  } catch (error) {
    await recordMutationFailure(deps, "UPDATE", "DENIED", startedAt, error);
    throw error;
  }
  const rowFilter = buildRowFilter(permission, deps.limits);
  const payloadChecks = buildPayloadChecks(permission, deps.limits);
  const mutationContext = {
    root: deps.root,
    fieldDecision: protectedFieldDecision(deps.root, permission.fieldDecision),
    rowFilter,
    payloadChecks,
    resolveUserVariable: userVariableResolver(deps.dataPrincipal),
    // The grant's row filter and payload checks may follow foreign keys (Security.md §6.5).
    related: relatedResolver(new SchemaContext(deps.context.database)),
    // PostgreSQL 18+: a table without a primary key still records its UPDATE audit's old values (Security.md §11.4).
    returningOld: (await deps.context.database.serverMajorVersion()) >= 18,
  };
  // Before BEGIN: the tables its filters reach are read through the pool now, never inside the transaction.
  await preloadRelations(mutationContext);
  const passwordColumns = await loadPasswordColumns(deps.context, deps.resourceId);
  const project = await mutationResponseProjection(deps.context, deps.dataPrincipal, deps.root, deps.resourceId, passwordColumns);
  const caller = await resolveWriteCaller((ids) => deps.context.effectivePermissions.isAdministrators(ids), deps.dataPrincipal);
  const oldValueFields = updateOldValueFields(deps);

  const outboxEventIds: string[] = [];
  try {
    const results = await deps.context.database.transaction(async (client: Queryable) => {
      const results: Record<string, unknown>[] = [];
      const batch = newWriteBatch();
      for (const op of operations) {
        assertGuardedColumnsWriteAllowed(deps.root, op.data, caller);
        await assertUserRoleAssignmentAllowed(client, deps.root, op.data, caller);
        const hashedData = await hashPasswordFields(deps.context, passwordColumns, op.data);
        const compiled = await compileUpdate(mutationContext, hashedData, op.where, oldValueFields, op.version);
        const { rows } = await client.query(compiled.sql, compiled.params);
        if (rows.length === 0 && op.version !== undefined && op.where) await assertNotStale(client, mutationContext, op.where);
        if (requireAtLeastOneRow && rows.length === 0) {
          throw new TotalBaseError("ROW_NOT_FOUND", "Row not found.");
        }
        for (const row of rows as Record<string, unknown>[]) {
          if (typeof row[ROW_VERSION_COLUMN] === "string") versions?.push(row[ROW_VERSION_COLUMN] as string);
          await assertAuthorizedRow(row, "UPDATE");
          assertValidRow(row, compiled.payloadCheckColumns);
          assertRoleOwnership(deps.root, row, caller);
          const clean = stripPasswordFields(stripInternal(row), passwordColumns);
          const oldRow = oldRowOf(row, compiled, passwordColumns);
          await queueAuditAndOutbox(deps, client, "UPDATE", startedAt, oldRow, clean, batch);
          results.push(project(clean));
        }
      }
      outboxEventIds.push(...(await flushWriteBatch(deps.context, client, batch)));
      return results;
    }, await writeTransactionContext(deps.context, deps.dataPrincipal));
    dispatchOutboxEventsEagerly(deps.context, outboxEventIds);
    return results;
  } catch (error) {
    await recordMutationFailure(deps, "UPDATE", "FAILED", startedAt, error);
    throw error;
  }
}

/** Executes one or many DELETE operations in a single transaction; any failure rolls back all of them. */
export async function executeDelete(
  deps: MutationDeps,
  operations: { where: FilterNode | undefined; version?: string | undefined }[],
  requireAtLeastOneRow: boolean,
): Promise<Record<string, unknown>[]> {
  const startedAt = new Date();
  let permission: EffectivePermission;
  try {
    permission = await resolvePermissionOrThrow(deps.context, deps.dataPrincipal, deps.root, deps.resourceId, "DELETE");
  } catch (error) {
    await recordMutationFailure(deps, "DELETE", "DENIED", startedAt, error);
    throw error;
  }
  const rowFilter = buildRowFilter(permission, deps.limits);
  // DELETE has no proposed values to check a business rule against
  // (Security.md §6.6, and see the Payload checks chat) - compileDelete
  // ignores this either way, only present so the shared
  // MutationCompileContext type is satisfied.
  const mutationContext = {
    root: deps.root,
    fieldDecision: protectedFieldDecision(deps.root, permission.fieldDecision),
    rowFilter,
    payloadChecks: undefined,
    resolveUserVariable: userVariableResolver(deps.dataPrincipal),
    // The grant's row filter and payload checks may follow foreign keys (Security.md §6.5).
    related: relatedResolver(new SchemaContext(deps.context.database)),
  };
  // Before BEGIN: the tables its filters reach are read through the pool now, never inside the transaction.
  await preloadRelations(mutationContext);
  const passwordColumns = await loadPasswordColumns(deps.context, deps.resourceId);
  const project = await mutationResponseProjection(deps.context, deps.dataPrincipal, deps.root, deps.resourceId, passwordColumns);
  const caller = await resolveWriteCaller((ids) => deps.context.effectivePermissions.isAdministrators(ids), deps.dataPrincipal);

  const outboxEventIds: string[] = [];
  try {
    const results = await deps.context.database.transaction(async (client: Queryable) => {
      const results: Record<string, unknown>[] = [];
      const batch = newWriteBatch();
      for (const op of operations) {
        const compiled = await compileDelete(mutationContext, op.where, op.version);
        const { rows } = await client.query(compiled.sql, compiled.params);
        if (rows.length === 0 && op.version !== undefined && op.where) await assertNotStale(client, mutationContext, op.where);
        if (requireAtLeastOneRow && rows.length === 0) {
          throw new TotalBaseError("ROW_NOT_FOUND", "Row not found.");
        }
        // DELETE ... RETURNING * returns the row as it existed before
        // deletion - the entry's `payload` (Security.md §11.4).
        for (const row of rows as Record<string, unknown>[]) {
          assertRolesDeleteAllowed(deps.root, row);
          assertRoleOwnership(deps.root, row, caller);
          await assertAssignmentDeleteAllowed(client, deps.root, row, caller);
          const clean = stripPasswordFields(row, passwordColumns);
          await queueAuditAndOutbox(deps, client, "DELETE", startedAt, clean, undefined, batch);
          results.push(project(clean));
        }
      }
      outboxEventIds.push(...(await flushWriteBatch(deps.context, client, batch)));
      return results;
    }, await writeTransactionContext(deps.context, deps.dataPrincipal));
    dispatchOutboxEventsEagerly(deps.context, outboxEventIds);
    return results;
  } catch (error) {
    await recordMutationFailure(deps, "DELETE", "FAILED", startedAt, error);
    throw error;
  }
}
