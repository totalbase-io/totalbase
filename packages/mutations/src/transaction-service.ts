import type { DatabaseTransactionContext, Queryable } from "@totalbase/database";
import { executeNestedPlan, hasNestedRelations, planNestedCreate, type NestedPlanNode } from "./nested-write-service.js";
import { TotalBaseError } from "@totalbase/errors";
import {
  compileDelete,
  compileInsert,
  compileUpdate,
  preloadRelations,
  relatedResolver,
  SchemaContext,
  type FilterNode,
} from "@totalbase/query-engine";
import { writeTransactionContext, type DataPrincipal, type MutationsContext } from "./context.js";
import { resolveTableResource } from "@totalbase/resources";
import {
  assertAssignmentDeleteAllowed,
  assertRoleOwnership,
  assertRolesDeleteAllowed,
  resolveWriteCaller,
  assertGuardedColumnsWriteAllowed,
  assertUserRoleAssignmentAllowed,
  protectedFieldDecision,
} from "./totalbase-guardrails.js";
import { hashPasswordFields, loadPasswordColumns, stripPasswordFields } from "./password-fields.js";
import { mutationResponseProjection } from "./response-projection.js";
import {
  assertAuthorizedRow,
  assertValidRow,
  auditAndEnqueue,
  buildRowFilter,
  buildPayloadChecks,
  recordMutationFailure,
  resolvePermissionOrThrow,
  oldRowOf,
  stripInternal,
  updateOldValueFields,
  userVariableResolver,
  type AuditRequestContext,
  type Limits,
  type MutationDeps,
} from "./mutation-service.js";

export type TransactionOperationKind = "insert" | "update" | "delete";

export interface TransactionOperationInput {
  key: string;
  operation: TransactionOperationKind;
  schema: string;
  table: string;
  /** Primary key value; required for update/delete, ignored for insert. */
  id?: unknown;
  /** Row data; required for insert/update, ignored for delete. */
  data?: Record<string, unknown>;
}

export interface TransactionRequest {
  operations: TransactionOperationInput[];
}

const BACKWARD_REFERENCE = /^\$([A-Za-z0-9_]+)\.(.+)$/;

/**
 * Substitutes `$key.field` backward references (Specification_Data_API.md §8) with the
 * value from an already-executed operation's result. Only backward
 * references are possible by construction: `results` only ever contains
 * keys for operations that ran earlier in the same sequential loop, so a
 * forward reference simply resolves to "unknown key" and is rejected -
 * there is no separate forward-reference detection pass needed.
 */
function resolveReferences(value: unknown, results: Map<string, Record<string, unknown>>): unknown {
  if (typeof value === "string") {
    const match = BACKWARD_REFERENCE.exec(value);
    if (!match) return value;
    const [, refKey, refField] = match as unknown as [string, string, string];
    const referenced = results.get(refKey);
    if (!referenced) {
      throw new TotalBaseError(
        "TRANSACTION_REFERENCE_NOT_FOUND",
        `Operation reference "$${refKey}.${refField}" does not refer to an earlier operation's key.`,
      );
    }
    if (!(refField in referenced)) {
      throw new TotalBaseError(
        "TRANSACTION_REFERENCE_NOT_FOUND",
        `Operation "${refKey}" has no field "${refField}" in its result.`,
      );
    }
    return referenced[refField];
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, results));
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      resolved[k] = resolveReferences(v, results);
    }
    return resolved;
  }
  return value;
}

function validateOperation(op: unknown, index: number): asserts op is TransactionOperationInput {
  if (typeof op !== "object" || op === null) {
    throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Operation at index ${index} must be an object.`);
  }
  const candidate = op as Record<string, unknown>;
  if (typeof candidate["key"] !== "string" || candidate["key"].length === 0) {
    throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Operation at index ${index} requires a non-empty "key".`);
  }
  if (!["insert", "update", "delete"].includes(candidate["operation"] as string)) {
    throw new TotalBaseError(
      "INVALID_TRANSACTION_PAYLOAD",
      `Operation "${candidate["key"]}" has an invalid "operation" (must be insert, update, or delete).`,
    );
  }
  if (typeof candidate["schema"] !== "string" || typeof candidate["table"] !== "string") {
    throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Operation "${candidate["key"]}" requires "schema" and "table".`);
  }
  if (candidate["operation"] !== "delete" && (typeof candidate["data"] !== "object" || candidate["data"] === null)) {
    throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Operation "${candidate["key"]}" requires "data".`);
  }
  if (candidate["operation"] !== "insert" && candidate["id"] === undefined) {
    throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Operation "${candidate["key"]}" requires "id".`);
  }
}

function singlePrimaryKeyField(root: { primaryKey: string[]; table: string }): string {
  if (root.primaryKey.length !== 1) {
    throw new TotalBaseError(
      "INVALID_TRANSACTION_PAYLOAD",
      `${root.table} does not have a simple primary key; transactions require one.`,
    );
  }
  return root.primaryKey[0]!;
}

function pkEqualsFilter(pkField: string, value: unknown): FilterNode {
  return { type: "comparison", path: [pkField], operator: "_eq", value: String(value) };
}

export interface TransactionDeps {
  context: MutationsContext;
  dataPrincipal: DataPrincipal;
  limits: Limits;
  audit: AuditRequestContext;
  /** Added to the transaction's own context - an asynchronous run's cancellation hooks (Specification_Data_API.md §10.5). */
  transactionContext?: Pick<DatabaseTransactionContext, "applicationName" | "beforeCommit"> | undefined;
}

/**
 * A DataView record's save (Specification_DataViews.md §6.6): its header and its lines, written together by the
 * DataView itself - not the public transactions API, so neither its switch nor the TRANSACTIONS capability applies.
 * Its caller has already kept the operations to the DataView's own tables; each is still authorized like any write.
 */
export interface TransactionOptions {
  recordSave?: { maxOperations: number };
}

/**
 * What a transaction is checked against before anything runs: the feature
 * on, the caller's TRANSACTIONS capability, a well-formed and bounded list
 * of operations. An asynchronous call (Specification_Data_API.md §10.4)
 * runs it before queueing too, so a request that can never run is refused
 * at once instead of failing in the background.
 */
export async function checkTransactionRequest(
  deps: Pick<TransactionDeps, "context" | "dataPrincipal">,
  request: TransactionRequest,
  options: TransactionOptions = {},
): Promise<void> {
  if (!options.recordSave) {
    if (!(await deps.context.settings.get("transactions.enabled"))) {
      throw new TotalBaseError("TRANSACTIONS_DISABLED", "Transactions are disabled.");
    }
    const decision = await deps.context.capabilityPermissions.resolve(deps.dataPrincipal.roleIds, "TRANSACTIONS");
    if (decision !== "ALLOW") {
      throw new TotalBaseError("TRANSACTION_EXECUTION_DENIED", "This principal is not authorized to execute transactions.");
    }
  }

  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", '"operations" must be a non-empty array.');
  }
  const maxOperations = options.recordSave?.maxOperations ?? (await deps.context.settings.get("transactions.max_operations"));
  if (request.operations.length > maxOperations) {
    throw new TotalBaseError(
      "TRANSACTION_LIMIT_EXCEEDED",
      `Transaction exceeds the configured maximum of ${maxOperations} operations.`,
    );
  }
  request.operations.forEach(validateOperation);

  const seenKeys = new Set<string>();
  for (const op of request.operations) {
    if (seenKeys.has(op.key)) {
      throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Duplicate operation key "${op.key}".`);
    }
    seenKeys.add(op.key);
  }
}

/**
 * Executes a batch of independent CREATE/UPDATE/DELETE operations in one
 * PostgreSQL transaction (Specification_Data_API.md §8). This
 * is a coordinator, not a second CRUD engine (Specification_Data_API.md §8): it reuses the
 * exact same permission resolution, row-filter, compile*, and audit/outbox
 * helpers as mutation-service.ts's single-operation entry points -
 * duplicated inline (rather than calling executeCreate/Update/Delete)
 * because those each open and commit their own transaction per call, and
 * every operation here must share one transaction with the others.
 */
export async function executeTransaction(
  deps: TransactionDeps,
  request: TransactionRequest,
  options: TransactionOptions = {},
): Promise<Record<string, Record<string, unknown>>> {
  await checkTransactionRequest(deps, request, options);

  const schemaContext = new SchemaContext(deps.context.database);
  const startedAt = new Date();
  const results = new Map<string, Record<string, unknown>>();
  /** The operation running - a failure names it (`operation` in the error), so a form marks that line. */
  let current: string | undefined;

  try {
    // Who writes (`totalbase.actor_user_id`) and how long a statement may run: transactions.timeout_ms, else the request timeout.
    const transactionContext = await writeTransactionContext(deps.context, deps.dataPrincipal);
    const ownTimeout = await deps.context.settings.get("transactions.timeout_ms");
    const caller = await resolveWriteCaller((ids) => deps.context.effectivePermissions.isAdministrators(ids), deps.dataPrincipal);

    // Everything an operation needs that isn't the transaction's own - its resource, permission, password
    // columns, response projection, a nested insert's plan - is resolved here, before BEGIN: inside the
    // transaction those reads would borrow a second pool connection while this one is held, and with every
    // connection in that state they would all wait on each other (Pre_Beta_Review 1.2).
    type Prepared = {
      op: TransactionOperationInput;
      action: "CREATE" | "UPDATE" | "DELETE";
      mutationDeps: MutationDeps;
      mutationContext: Parameters<typeof compileInsert>[0];
      passwordColumns: Set<string>;
      project: (row: Record<string, unknown>) => Record<string, unknown>;
    };
    const prepared: Prepared[] = [];
    for (const op of request.operations) {
      current = op.key;
      const method = op.operation === "insert" ? "POST" : op.operation === "update" ? "PATCH" : "DELETE";
      const resource = await resolveTableResource(deps.context, op.schema, op.table, method);
      const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);
      const action = op.operation === "insert" ? "CREATE" : op.operation === "update" ? "UPDATE" : "DELETE";
      const mutationDeps: MutationDeps = {
        context: deps.context,
        dataPrincipal: deps.dataPrincipal,
        resourceId: resource.id,
        root,
        limits: deps.limits,
        audit: deps.audit,
      };
      let permission;
      try {
        permission = await resolvePermissionOrThrow(deps.context, deps.dataPrincipal, root, resource.id, action);
      } catch (error) {
        await recordMutationFailure(mutationDeps, action, "DENIED", startedAt, error);
        throw error;
      }
      const mutationContext = {
        root,
        fieldDecision: protectedFieldDecision(root, permission.fieldDecision),
        rowFilter: buildRowFilter(permission, deps.limits),
        payloadChecks: buildPayloadChecks(permission, deps.limits),
        resolveUserVariable: userVariableResolver(deps.dataPrincipal),
        // The grant's row filter and payload checks may follow foreign keys (Specification_Security.md §6.5).
        related: relatedResolver(schemaContext),
      };
      // Before BEGIN: the tables its filters reach are read through the pool now, never inside the transaction.
      await preloadRelations(mutationContext);
      const passwordColumns = await loadPasswordColumns(deps.context, resource.id);
      // Later operations' `$ref`s resolve against this projected row too - otherwise a reference could copy a
      // column the caller can't read into one it can.
      const project = await mutationResponseProjection(deps.context, deps.dataPrincipal, root, resource.id, passwordColumns);
      prepared.push({ op, action, mutationDeps, mutationContext, passwordColumns, project });
    }

    await deps.context.database.transaction(async (client: Queryable) => {
      for (const { op, mutationDeps, mutationContext, passwordColumns, project } of prepared) {
        current = op.key;
        const { root } = mutationDeps;

        if (op.operation === "insert" && hasNestedRelations(op.data)) {
          // A nested CREATE inside the transaction (§8): the one write engine, on this same client. Its plan
          // is made here because its `$ref`s need the earlier operations' rows; its own reads are the plan's.
          const data = resolveReferences(op.data, results) as Record<string, unknown>;
          const plan: NestedPlanNode = await planNestedCreate(deps, schemaContext, mutationDeps.resourceId, root, data, caller);
          results.set(op.key, await executeNestedPlan(client, deps, plan, startedAt));
        } else if (op.operation === "insert") {
          const data = resolveReferences(op.data, results) as Record<string, unknown>;
          assertGuardedColumnsWriteAllowed(root, data, caller);
          await assertUserRoleAssignmentAllowed(client, root, data, caller);
          const hashedData = await hashPasswordFields(deps.context, passwordColumns, data);
          const compiled = await compileInsert(mutationContext, hashedData, undefined);
          const { rows } = await client.query(compiled.sql, compiled.params);
          const row = (rows as Record<string, unknown>[])[0];
          if (!row) throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Operation "${op.key}" produced no row.`);
          await assertAuthorizedRow(row, "CREATE");
          assertValidRow(row, compiled.payloadCheckColumns);
          const clean = stripPasswordFields(stripInternal(row), passwordColumns);
          await auditAndEnqueue(mutationDeps, client, "CREATE", startedAt, undefined, clean);
          results.set(op.key, project(clean));
        } else if (op.operation === "update") {
          const pkField = singlePrimaryKeyField(root);
          const id = resolveReferences(op.id, results);
          const data = resolveReferences(op.data, results) as Record<string, unknown>;
          assertGuardedColumnsWriteAllowed(root, data, caller);
          await assertUserRoleAssignmentAllowed(client, root, data, caller);
          const hashedData = await hashPasswordFields(deps.context, passwordColumns, data);
          const compiled = await compileUpdate(mutationContext, hashedData, pkEqualsFilter(pkField, id), updateOldValueFields(mutationDeps));
          const { rows } = await client.query(compiled.sql, compiled.params);
          const row = (rows as Record<string, unknown>[])[0];
          if (!row) throw new TotalBaseError("ROW_NOT_FOUND", `Operation "${op.key}": row not found.`);
          await assertAuthorizedRow(row, "UPDATE");
          assertValidRow(row, compiled.payloadCheckColumns);
          assertRoleOwnership(root, row, caller);
          const clean = stripPasswordFields(stripInternal(row), passwordColumns);
          await auditAndEnqueue(mutationDeps, client, "UPDATE", startedAt, oldRowOf(row, compiled, passwordColumns), clean);
          results.set(op.key, project(clean));
        } else {
          const pkField = singlePrimaryKeyField(root);
          const id = resolveReferences(op.id, results);
          const compiled = await compileDelete(mutationContext, pkEqualsFilter(pkField, id));
          const { rows } = await client.query(compiled.sql, compiled.params);
          const row = (rows as Record<string, unknown>[])[0];
          if (!row) throw new TotalBaseError("ROW_NOT_FOUND", `Operation "${op.key}": row not found.`);
          assertRolesDeleteAllowed(root, row);
          assertRoleOwnership(root, row, caller);
          await assertAssignmentDeleteAllowed(client, root, row, caller);
          const clean = stripPasswordFields(row, passwordColumns);
          await auditAndEnqueue(mutationDeps, client, "DELETE", startedAt, clean, undefined);
          results.set(op.key, project(clean));
        }
      }
    }, { ...transactionContext, ...(ownTimeout > 0 ? { statementTimeoutMs: ownTimeout } : {}), ...deps.transactionContext });
  } catch (error) {
    // A single shared audit "transaction failed" record isn't meaningful
    // per-resource; each operation's own recordMutationFailure() (DENIED
    // path above) or the thrown TotalBaseError itself is the record of
    // what went wrong. The whole DB transaction already rolled back.
    if (error instanceof TotalBaseError && current && !error.operation) throw error.inOperation(current);
    throw error;
  }

  return Object.fromEntries(results);
}
