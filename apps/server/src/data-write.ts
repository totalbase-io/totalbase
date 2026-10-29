import type { FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { assertFilterComplexity, assertFilterFeatures, parseFilter, SchemaContext, type FilterNode, type OnConflictSpec } from "@totalbase/query-engine";
import type { ResolvedApiResource } from "@totalbase/resources";
import {
  executeCreate,
  executeDelete,
  executeNestedCreate,
  executeUpdate,
  hasNestedRelations,
  rowFilterLimits,
  type AuditRequestContext,
  type MutationDeps,
} from "@totalbase/mutations";
import type { AppContext } from "./context.js";
import type { DataPrincipal } from "./data-principal.js";
import { loadQueryFeatures } from "./query-features.js";

/**
 * The Data API's write path for a TABLE (Data_API.md §5, §5.7, §8), callable
 * without an HTTP request, as data-read.ts is for reads: the routes call it,
 * and so can anything else that writes as a principal (GraphQL,
 * Data_API.md §17). The caller resolves the principal and the resource
 * and keeps what is HTTP's - the Idempotency-Key, If-Match, the ETag; this
 * checks the payload's shape and the api.* limits and runs the write through
 * @totalbase/mutations (permissions, audit and outbox in one transaction).
 *
 * Bulk UPDATE/DELETE convention (not fully specified in the source
 * document - see AGENTS.md section 27): each item in a bulk `data` array
 * must carry the resource's primary key value, used to target that row;
 * for UPDATE, remaining fields in the item become the SET values.
 */
export function writeOrigin(request: FastifyRequest): AuditRequestContext {
  return { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" };
}

export interface CreateRowsInput {
  data: unknown;
  bulk: boolean;
  onConflict?: OnConflictSpec | undefined;
}

/** A collection UPDATE or DELETE: a bulk array of rows by key, or one `where` (the filter grammar, unparsed). */
export interface WriteRowsInput {
  data: unknown;
  bulk: boolean;
  where?: unknown;
}

export async function createRows(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  input: CreateRowsInput,
  audit: AuditRequestContext,
): Promise<unknown> {
  const deps = await mutationDeps(context, dataPrincipal, resource, audit);
  const { data, bulk } = input;

  if (bulk) {
    if (!Array.isArray(data)) {
      throw new TotalBaseError("INVALID_BULK_PAYLOAD", "bulk=true requires data to be an array.");
    }
    if (data.some((item) => hasNestedRelations(item))) {
      throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "Nested writes are not supported with bulk=true.");
    }
    await assertBulkSize(context, data.length);
    return executeCreate(deps, data as Record<string, unknown>[], input.onConflict);
  }

  if (hasNestedRelations(data)) {
    if (input.onConflict !== undefined) {
      throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "on_conflict is not supported with nested writes.");
    }
    return executeNestedCreate(
      { context, dataPrincipal, limits: deps.limits, audit },
      new SchemaContext(context.database),
      resource.id,
      deps.root,
      data,
    );
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TotalBaseError("INVALID_QUERY", "data must be an object.");
  }
  const results = await executeCreate(deps, [data as Record<string, unknown>], input.onConflict);
  return results[0];
}

/** One row by its single-column primary key; `version` is If-Match's (Data_API.md §5.3). Returns the row and its new version. */
export async function updateRowByKey(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  pk: string,
  data: unknown,
  version: string | undefined,
  audit: AuditRequestContext,
): Promise<{ row: Record<string, unknown> | undefined; version: string | undefined }> {
  const deps = await mutationDeps(context, dataPrincipal, resource, audit);
  const pkField = singlePrimaryKeyField(deps.root);

  if (typeof data !== "object" || data === null) {
    throw new TotalBaseError("INVALID_QUERY", "data must be an object.");
  }
  if (hasNestedRelations(data)) {
    // Nested UPDATE is deferred to a later version (Roadmap_v3.md §2.1).
    throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "Nested writes are not supported on UPDATE yet.");
  }

  const versions: string[] = [];
  const results = await executeUpdate(
    deps,
    [{ data: data as Record<string, unknown>, where: pkEqualsFilter(pkField, pk), version }],
    true,
    versions,
  );
  return { row: results[0], version: versions[0] };
}

export async function updateRows(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  input: WriteRowsInput,
  audit: AuditRequestContext,
): Promise<Record<string, unknown>[]> {
  const deps = await mutationDeps(context, dataPrincipal, resource, audit);
  const { data } = input;

  if (input.bulk) {
    if (!Array.isArray(data)) {
      throw new TotalBaseError("INVALID_BULK_PAYLOAD", "bulk=true requires data to be an array.");
    }
    if (data.some((item) => hasNestedRelations(item))) {
      throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "Nested writes are not supported on UPDATE yet.");
    }
    await assertBulkSize(context, data.length);
    const pkField = singlePrimaryKeyField(deps.root);
    const operations = (data as Record<string, unknown>[]).map((item) => {
      const { [pkField]: pkValue, ...rest } = item;
      if (pkValue === undefined) {
        throw new TotalBaseError("INVALID_BULK_PAYLOAD", `Each bulk item requires "${pkField}".`);
      }
      return { data: rest, where: pkEqualsFilter(pkField, pkValue) };
    });
    return executeUpdate(deps, operations, true);
  }

  const where = await collectionWhere(context, deps, input.where, "UPDATE", await context.settings.get("api.require_where_for_update"));

  if (typeof data !== "object" || data === null) {
    throw new TotalBaseError("INVALID_QUERY", "data must be an object.");
  }
  if (hasNestedRelations(data)) {
    throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "Nested writes are not supported on UPDATE yet.");
  }
  return executeUpdate(deps, [{ data: data as Record<string, unknown>, where }], false);
}

/** One row by its single-column primary key; `version` is If-Match's (Data_API.md §5.3). */
export async function deleteRowByKey(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  pk: string,
  version: string | undefined,
  audit: AuditRequestContext,
): Promise<Record<string, unknown> | undefined> {
  const deps = await mutationDeps(context, dataPrincipal, resource, audit);
  const pkField = singlePrimaryKeyField(deps.root);
  const results = await executeDelete(deps, [{ where: pkEqualsFilter(pkField, pk), version }], true);
  return results[0];
}

export async function deleteRows(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  input: WriteRowsInput,
  audit: AuditRequestContext,
): Promise<Record<string, unknown>[]> {
  const deps = await mutationDeps(context, dataPrincipal, resource, audit);
  const { data } = input;

  if (input.bulk) {
    if (!Array.isArray(data)) {
      throw new TotalBaseError("INVALID_BULK_PAYLOAD", "bulk=true requires data to be an array.");
    }
    await assertBulkSize(context, data.length);
    const pkField = singlePrimaryKeyField(deps.root);
    const operations = (data as Record<string, unknown>[]).map((item) => {
      const pkValue = item[pkField];
      if (pkValue === undefined) {
        throw new TotalBaseError("INVALID_BULK_PAYLOAD", `Each bulk item requires "${pkField}".`);
      }
      return { where: pkEqualsFilter(pkField, pkValue) };
    });
    return executeDelete(deps, operations, true);
  }

  const where = await collectionWhere(context, deps, input.where, "DELETE", await context.settings.get("api.require_where_for_delete"));
  return executeDelete(deps, [{ where }], false);
}

async function mutationDeps(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  audit: AuditRequestContext,
): Promise<MutationDeps> {
  const limits = await rowFilterLimits(context);
  const root = await new SchemaContext(context.database).loadRoot(resource.schema, resource.name, resource.postgresOid);
  return { context, dataPrincipal, resourceId: resource.id, root, limits, audit };
}

/** A collection write's `where`: required unless the setting allows none, then within the request limits (Data_API.md §12). */
async function collectionWhere(
  context: AppContext,
  deps: MutationDeps,
  whereRaw: unknown,
  action: "UPDATE" | "DELETE",
  requireWhere: boolean,
): Promise<FilterNode | undefined> {
  if (whereRaw === undefined && requireWhere) {
    const setting = action === "UPDATE" ? "api.require_where_for_update" : "api.require_where_for_delete";
    throw new TotalBaseError("INVALID_QUERY", `where is required for collection ${action} (${setting}).`);
  }
  const where = whereRaw !== undefined ? parseFilter(whereRaw, deps.limits, 0) : undefined;
  assertFilterComplexity(where, await context.settings.get("api.max_query_nodes"));
  assertFilterFeatures(where, await loadQueryFeatures(context));
  return where;
}

async function assertBulkSize(context: AppContext, count: number): Promise<void> {
  const max = await context.settings.get("api.bulk_max_items");
  if (count > max) {
    throw new TotalBaseError("INVALID_BULK_PAYLOAD", `Bulk request exceeds api.bulk_max_items (${max}).`);
  }
}

function singlePrimaryKeyField(root: { primaryKey: string[]; table: string }): string {
  if (root.primaryKey.length !== 1) {
    throw new TotalBaseError(
      "INVALID_QUERY",
      `${root.table} does not have a simple primary key; bulk operations require one.`,
    );
  }
  return root.primaryKey[0]!;
}

function pkEqualsFilter(pkField: string, value: unknown): FilterNode {
  return { type: "comparison", path: [pkField], operator: "_eq", value: String(value) };
}
