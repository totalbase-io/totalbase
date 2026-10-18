import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { compileInsert, preloadRelations, quoteIdentifier, relatedResolver, SchemaContext, type ResolvedResource } from "@totalbase/query-engine";
import { writeTransactionContext, type DataPrincipal, type MutationsContext } from "./context.js";
import { assertGuardedColumnsWriteAllowed, assertUserRoleAssignmentAllowed, protectedFieldDecision, resolveWriteCaller } from "./totalbase-guardrails.js";
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
  stripInternal,
  userVariableResolver,
  type AuditRequestContext,
  type Limits,
  type MutationDeps,
} from "./mutation-service.js";

/**
 * Nested writes (Specification_Data_API.md §6). This is a SEPARATE
 * entry point from mutation-service.ts, not a modification of
 * executeCreate: a nested write needs ONE transaction shared across every
 * node in the tree, so it calls compileInsert directly per node instead
 * of going through executeCreate (which opens its own transaction per
 * call). Nested UPDATE is deferred (Roadmap_v3.md §2.1) - only nested
 * CREATE is implemented here.
 */
export interface NestedWriteDeps {
  context: MutationsContext;
  dataPrincipal: DataPrincipal;
  limits: Limits;
  audit: AuditRequestContext;
}

interface NestedChildGroup {
  relationName: string;
  fkColumn: string;
  parentColumn: string;
  items: NestedPlanNode[];
}

/** What a node's INSERT needs from outside the transaction: resolved before BEGIN (prepareNode), never on a second pool connection inside it. */
interface PreparedNode {
  mutationContext: Parameters<typeof compileInsert>[0];
  passwordColumns: Set<string>;
  project: (row: Record<string, unknown>) => Record<string, unknown>;
  caller: Awaited<ReturnType<typeof resolveWriteCaller>>;
}

export interface NestedPlanNode {
  resourceId: string;
  resource: ResolvedResource;
  scalarData: Record<string, unknown>;
  children: NestedChildGroup[];
  prepared?: PreparedNode;
}

/** True for a plain JSON object as sent over the wire (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Preflight: walks the payload, splits scalar columns from `$relation`
 * properties, resolves each relation against real PostgreSQL foreign
 * keys, and enforces depth/record limits - all before any write executes
 * (Specification_Data_API.md §6.3). Runs against `context.database` directly (not a
 * transaction client); the actual writes happen later, inside one
 * transaction, in executeNode.
 */
async function buildPlanNode(
  schemaContext: SchemaContext,
  resource: ResolvedResource,
  resourceId: string,
  payload: Record<string, unknown>,
  depth: number,
  maxDepth: number,
  maxRecords: number,
  counter: { count: number },
): Promise<NestedPlanNode> {
  const scalarData: Record<string, unknown> = {};
  const children: NestedChildGroup[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (!key.startsWith("$")) {
      scalarData[key] = value;
      continue;
    }

    const childTable = key.slice(1);
    if (!Array.isArray(value) || value.some((item) => !isPlainObject(item))) {
      throw new TotalBaseError("INVALID_NESTED_PAYLOAD", `"${key}" must be an array of objects.`);
    }
    // An empty array is still a relation instruction: checked like any other
    // (depth, relation), and answered as `$child: []`.

    if (depth + 1 > maxDepth) {
      throw new TotalBaseError(
        "NESTED_MAX_DEPTH_EXCEEDED",
        `Nested depth exceeds api.nested_write_max_depth (${maxDepth}).`,
      );
    }

    const child = await schemaContext.resolveNestedChild(resource, childTable, "POST");

    const items: NestedPlanNode[] = [];
    for (const rawItem of value as Record<string, unknown>[]) {
      if (Object.prototype.hasOwnProperty.call(rawItem, child.fkColumn)) {
        throw new TotalBaseError(
          "NESTED_FOREIGN_KEY_NOT_ALLOWED",
          `"${key}" items must not supply "${child.fkColumn}"; it is propagated automatically from the parent.`,
        );
      }
      counter.count += 1;
      if (counter.count > maxRecords) {
        throw new TotalBaseError(
          "NESTED_MAX_RECORDS_EXCEEDED",
          `Nested request exceeds api.nested_write_max_records (${maxRecords}).`,
        );
      }
      items.push(
        await buildPlanNode(schemaContext, child.resource, child.resourceId, rawItem, depth + 1, maxDepth, maxRecords, counter),
      );
    }
    children.push({ relationName: childTable, fkColumn: child.fkColumn, parentColumn: child.parentColumn, items });
  }

  return { resourceId, resource, scalarData, children };
}

/**
 * Resolves, for every node of the plan, what its INSERT needs that isn't
 * the transaction's own: its permission, password columns, response
 * projection and caller - all through the pool, all before BEGIN, so the
 * transaction never waits on a second connection (Pre_Beta_Review 1.2).
 */
async function prepareNode(deps: NestedWriteDeps, node: NestedPlanNode, caller: PreparedNode["caller"]): Promise<void> {
  const permission = await resolvePermissionOrThrow(deps.context, deps.dataPrincipal, node.resource, node.resourceId, "CREATE");
  const passwordColumns = await loadPasswordColumns(deps.context, node.resourceId);
  node.prepared = {
    mutationContext: {
      root: node.resource,
      fieldDecision: protectedFieldDecision(node.resource, permission.fieldDecision),
      rowFilter: buildRowFilter(permission, deps.limits),
      payloadChecks: buildPayloadChecks(permission, deps.limits),
      resolveUserVariable: userVariableResolver(deps.dataPrincipal),
      // The grant's row filter and payload checks may follow foreign keys (Specification_Security.md §6.5).
      related: relatedResolver(new SchemaContext(deps.context.database)),
    },
    passwordColumns,
    // The caller sees only what READ would show; the full row still feeds audit and the child FK values.
    project: await mutationResponseProjection(deps.context, deps.dataPrincipal, node.resource, node.resourceId, passwordColumns),
    caller,
  };
  // Before BEGIN: the tables its filters reach are read through the pool now, never inside the transaction.
  await preloadRelations(node.prepared.mutationContext);
  for (const group of node.children) for (const item of group.items) await prepareNode(deps, item, caller);
}

/**
 * Executes one plan node's INSERT (propagating the parent key when this
 * is a child) and recurses into its own children, all on the SAME
 * transaction client (Specification_Data_API.md §6.4: one logical operation, one
 * transaction). Reuses the exact permission/column/audit machinery
 * executeCreate uses per row, just without executeCreate's own
 * transaction boundary.
 */
async function executeNode(
  client: Queryable,
  deps: NestedWriteDeps,
  node: NestedPlanNode,
  startedAt: Date,
  link: { fkColumn: string; parentValue: unknown } | undefined,
): Promise<Record<string, unknown>> {
  const { mutationContext, passwordColumns, project, caller } = node.prepared!;
  const data = link ? { ...node.scalarData, [link.fkColumn]: link.parentValue } : node.scalarData;
  assertGuardedColumnsWriteAllowed(node.resource, data, caller);
  await assertUserRoleAssignmentAllowed(client, node.resource, data, caller);
  const hashedData = await hashPasswordFields(deps.context, passwordColumns, data);
  const compiled = await compileInsert(mutationContext, hashedData);
  const { rows } = await client.query(compiled.sql, compiled.params);
  const row = rows[0] as Record<string, unknown>;
  await assertAuthorizedRow(row, "CREATE");
  assertValidRow(row, compiled.payloadCheckColumns);
  const clean = stripPasswordFields(stripInternal(row), passwordColumns);

  const nodeDeps: MutationDeps = {
    context: deps.context,
    dataPrincipal: deps.dataPrincipal,
    resourceId: node.resourceId,
    root: node.resource,
    limits: deps.limits,
    audit: deps.audit,
  };
  await auditAndEnqueue(nodeDeps, client, "CREATE", startedAt, undefined, clean);

  if (node.children.length === 0) return project(clean);
  const childResults: Record<string, unknown> = {};
  for (const group of node.children) {
    const parentValue = clean[group.parentColumn];
    const items: Record<string, unknown>[] = [];
    for (const childNode of group.items) {
      items.push(await executeNode(client, deps, childNode, startedAt, { fkColumn: group.fkColumn, parentValue }));
    }
    childResults[`$${group.relationName}`] = items;
  }
  // A child's trigger may have changed its parent (an order's totals recalculated from its lines): the answer
  // is the parent as it stands once its children are in, not the INSERT's RETURNING from before them.
  const current = await rereadRow(client, node.resource, node.resource.primaryKey.length > 0 ? node.resource.primaryKey : [node.children[0]!.parentColumn], clean);
  return { ...project(stripPasswordFields(current ?? clean, passwordColumns)), ...childResults };
}

/** The row as it is now on this transaction, found by `keyColumns` (the primary key, or a referenced unique column). */
async function rereadRow(
  client: Queryable,
  resource: ResolvedResource,
  keyColumns: string[],
  row: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const where = keyColumns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(" AND ");
  const { rows } = await client.query(
    `SELECT * FROM ${quoteIdentifier(resource.schema)}.${quoteIdentifier(resource.table)} WHERE ${where}`,
    keyColumns.map((column) => row[column]),
  );
  return rows[0] as Record<string, unknown> | undefined;
}

/**
 * Nested CREATE entry point. `rawPayload` is the request body's `data`
 * object, potentially containing `$child_resource` array properties at
 * any depth up to `api.nested_write_max_depth`.
 */
export async function executeNestedCreate(
  deps: NestedWriteDeps,
  schemaContext: SchemaContext,
  resourceId: string,
  root: ResolvedResource,
  rawPayload: unknown,
): Promise<Record<string, unknown>> {
  if (!isPlainObject(rawPayload)) {
    throw new TotalBaseError("INVALID_QUERY", "data must be an object.");
  }

  const startedAt = new Date();
  const failureDeps: MutationDeps = {
    context: deps.context,
    dataPrincipal: deps.dataPrincipal,
    resourceId,
    root,
    limits: deps.limits,
    audit: deps.audit,
  };

  // 1-3, enforced by the settings registry (Specification_Data_API.md §6.3).
  const maxDepth = await deps.context.settings.get("api.nested_write_max_depth");
  const maxRecords = await deps.context.settings.get("api.nested_write_max_records");

  let plan: NestedPlanNode;
  try {
    plan = await buildPlanNode(schemaContext, root, resourceId, rawPayload, 0, maxDepth, maxRecords, { count: 1 });
  } catch (error) {
    await recordMutationFailure(failureDeps, "CREATE", "FAILED", startedAt, error);
    throw error;
  }

  try {
    await prepareNode(deps, plan, await resolveWriteCaller((ids) => deps.context.effectivePermissions.isAdministrators(ids), deps.dataPrincipal));
    return await deps.context.database.transaction(
      (client) => executeNode(client, deps, plan, startedAt, undefined),
      await writeTransactionContext(deps.context, deps.dataPrincipal),
    );
  } catch (error) {
    await recordMutationFailure(failureDeps, "CREATE", "FAILED", startedAt, error);
    throw error;
  }
}

/**
 * A nested CREATE on a transaction already open - a `POST /api/transactions`
 * insert operation carrying `$child` arrays (Specification_Data_API.md §8):
 * the same plan, limits and per-node authorization as executeNestedCreate.
 * Planned and prepared before that transaction begins (planNestedCreate),
 * executed on the caller's client (executeNestedPlan), so the whole tree
 * commits or rolls back with the rest of the transaction.
 */
export async function planNestedCreate(
  deps: NestedWriteDeps,
  schemaContext: SchemaContext,
  resourceId: string,
  root: ResolvedResource,
  rawPayload: Record<string, unknown>,
  caller: PreparedNode["caller"],
): Promise<NestedPlanNode> {
  const maxDepth = await deps.context.settings.get("api.nested_write_max_depth");
  const maxRecords = await deps.context.settings.get("api.nested_write_max_records");
  const plan = await buildPlanNode(schemaContext, root, resourceId, rawPayload, 0, maxDepth, maxRecords, { count: 1 });
  await prepareNode(deps, plan, caller);
  return plan;
}

export function executeNestedPlan(client: Queryable, deps: NestedWriteDeps, plan: NestedPlanNode, startedAt: Date): Promise<Record<string, unknown>> {
  return executeNode(client, deps, plan, startedAt, undefined);
}

/** True if the payload contains any `$`-prefixed nested-relation property at its top level. */
export function hasNestedRelations(payload: unknown): boolean {
  return isPlainObject(payload) && Object.keys(payload).some((key) => key.startsWith("$"));
}
