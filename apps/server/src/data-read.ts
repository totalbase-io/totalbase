import {
  assertQueryFeatures,
  compileSelect, takeFlags,
  parseQuery,
  ROW_VERSION_COLUMN,
  SchemaContext,
  type FilterNode,
} from "@totalbase/query-engine";
import { TotalBaseError, deniedMessage } from "@totalbase/errors";
import type { ResolvedApiResource } from "@totalbase/resources";
import { buildRowFilter, dataApiTimeout, loadPasswordColumns, protectedFieldDecision, userVariableResolver, withPasswordColumnsDenied } from "@totalbase/mutations";
import type { AppContext } from "./context.js";
import type { DataPrincipal } from "./data-principal.js";
import { loadQueryFeatures } from "./query-features.js";
import { ReadAudit, type ReadOrigin } from "./read-audit.js";

/**
 * The Data API's read path (Data_API.md §1.2, §4), callable without an HTTP
 * request: the routes of a TABLE or VIEW call it, and so can anything else
 * that reads as a principal (realtime, Data_API.md §16.4, §16.5; GraphQL,
 * Roadmap_v2.md §2.10). The caller resolves the principal and the resource;
 * this resolves READ, parses and compiles the query, runs it and writes the
 * READ audit row (§4.3).
 */
export interface ReadRowsResult {
  data: Record<string, unknown>[];
  meta?: { count?: number; flags?: unknown };
}

/**
 * Authorizes a read and compiles it, without running it: READ, the fields and the filter, as a request would
 * be refused (Data_API.md §3.2, §11.5). A refusal is audited like a read's.
 */
async function prepareRows(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  rawQuery: Record<string, unknown>,
  readAudit: ReadAudit,
) {
  const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resource.id, "READ");
  if (permission.action !== "ALLOW") {
    const error = new TotalBaseError("ACTION_DENIED", deniedMessage("READ", resource.schema, resource.name));
    await readAudit.failed("DENIED", { where: rawQuery["where"] }, error);
    throw error;
  }

  const [defaultLimit, maxLimit, maxOffset, maxRelationDepth, maxFilterDepth, maxQueryNodes] = await Promise.all([
    context.settings.get("api.default_limit"),
    context.settings.get("api.max_limit"),
    context.settings.get("api.max_offset"),
    context.settings.get("api.max_relation_depth"),
    context.settings.get("api.max_filter_depth"),
    context.settings.get("api.max_query_nodes"),
  ]);
  const limits = { maxFilterDepth, maxRelationDepth, maxQueryNodes };

  const ast = parseQuery(rawQuery, limits);
  assertQueryFeatures(ast, await loadQueryFeatures(context));
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
  return { ast, compiled };
}

/** Whether `dataPrincipal` may read `resource` with `rawQuery` - throws the refusal a read would get, runs nothing. */
export async function authorizeRows(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  rawQuery: Record<string, unknown>,
  origin: ReadOrigin,
): Promise<void> {
  await prepareRows(context, dataPrincipal, resource, rawQuery, new ReadAudit(context, origin, resource, dataPrincipal));
}

export async function readRows(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  rawQuery: Record<string, unknown>,
  origin: ReadOrigin,
): Promise<ReadRowsResult> {
  const readAudit = new ReadAudit(context, origin, resource, dataPrincipal);
  const { ast, compiled } = await prepareRows(context, dataPrincipal, resource, rawQuery, readAudit);

  // Rows, count and the READ audit row (audit_read) in one
  // transaction: one statement_timeout (api.request_timeout_ms) and one
  // snapshot for both, and no data returned the log didn't record.
  const auditDetail = { fields: ast.fields, where: rawQuery["where"], search: ast.search };
  try {
    return await context.database.transaction(async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(compiled.sql, compiled.params);
      // Which flags each row met (Data_API.md §3.9) - their columns out of the rows.
      const flags = takeFlags(rows, ast.flags);
      if (ast.count && compiled.countSql) {
        const { rows: countRows } = await client.query<{ count: string }>(compiled.countSql, compiled.countParams);
        const count = Number(countRows[0]?.count ?? 0);
        await readAudit.executed(client, auditDetail, rows.length, count);
        return { data: rows, meta: { count, ...(flags && { flags }) } };
      }
      await readAudit.executed(client, auditDetail, rows.length);
      return flags ? { data: rows, meta: { flags } } : { data: rows };
    }, await dataApiTimeout(context, dataPrincipal));
  } catch (error) {
    await readAudit.failed("FAILED", auditDetail, error);
    throw error;
  }
}

/** One row by its single-column primary key, with its version (Data_API.md §4.2, §5.3). */
export async function readRowByKey(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  resource: ResolvedApiResource,
  pk: string,
  origin: ReadOrigin,
): Promise<{ row: Record<string, unknown>; version: string | undefined }> {
  const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resource.id, "READ");
  const readAudit = new ReadAudit(context, origin, resource, dataPrincipal);
  if (permission.action !== "ALLOW") {
    const error = new TotalBaseError("ACTION_DENIED", deniedMessage("READ", resource.schema, resource.name));
    await readAudit.failed("DENIED", { pk }, error);
    throw error;
  }

  const [maxFilterDepth, maxRelationDepth] = await Promise.all([
    context.settings.get("api.max_filter_depth"),
    context.settings.get("api.max_relation_depth"),
  ]);
  const limits = { maxFilterDepth, maxRelationDepth };

  const schemaContext = new SchemaContext(context.database);
  const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);

  if (root.primaryKey.length !== 1) {
    throw new TotalBaseError(
      "INVALID_QUERY",
      "This resource does not have a simple primary key and cannot be fetched individually.",
    );
  }

  const pkFilter: FilterNode = {
    type: "comparison",
    path: [root.primaryKey[0]!],
    operator: "_eq",
    value: pk,
  };
  // The grant's row filter goes as the row filter, not into the request's where: its paths are the
  // administrator's and need no field grant (Security.md §6.5) - as a list read has it.
  const rowFilter = buildRowFilter(permission, limits);
  const passwordColumns = await loadPasswordColumns(context, resource.id);

  const compiled = await compileSelect({
    root,
    ast: { ...emptyAst(), where: pkFilter },
    schemaContext,
    fieldDecision: withPasswordColumnsDenied(protectedFieldDecision(root, permission.fieldDecision), passwordColumns),
    rowFilter,
    resolveUserVariable: userVariableResolver(dataPrincipal),
    defaultLimit: 1,
    maxLimit: 1,
    maxOffset: 0,
    withVersion: true,
  });

  // A by-key read is audited with its key, found or not (a miss is
  // still a lookup someone made) - inside the read's own transaction.
  const pkColumn = root.primaryKey[0]!;
  const auditDetail = { where: { [pkColumn]: { _eq: pk } }, pk };
  let rows: Record<string, unknown>[];
  try {
    rows = await context.database.transaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(compiled.sql, compiled.params);
      await readAudit.executed(client, auditDetail, result.rows.length);
      return result.rows;
    }, await dataApiTimeout(context, dataPrincipal));
  } catch (error) {
    await readAudit.failed("FAILED", auditDetail, error);
    throw error;
  }
  if (rows.length === 0) {
    throw new TotalBaseError("ROW_NOT_FOUND", "Row not found.");
  }
  // Its version, for an optimistic write's If-Match (Data_API.md §5.3) - never a field of the row.
  const { [ROW_VERSION_COLUMN]: version, ...row } = rows[0]!;
  return { row, version: typeof version === "string" ? version : undefined };
}

function emptyAst() {
  return {
    fields: undefined,
    where: undefined,
    search: undefined,
    groupBy: undefined,
    having: undefined,
    aggregates: undefined,
    orderBy: undefined,
    limit: undefined,
    offset: undefined,
    count: false,
  };
}
