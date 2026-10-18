import type { FastifyInstance } from "fastify";
import {
  assertQueryFeatures,
  compileSelect, takeFlags,
  parseFilter,
  parseQuery,
  ROW_VERSION_COLUMN,
  SchemaContext,
  type FilterNode,
} from "@totalbase/query-engine";
import { TotalBaseError, deniedMessage } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { resolveTableResource } from "@totalbase/resources";
import { buildRowFilter, dataApiTimeout, loadPasswordColumns, protectedFieldDecision, userVariableResolver, withPasswordColumnsDenied } from "@totalbase/mutations";
import { loadQueryFeatures } from "../query-features.js";
import { ReadAudit } from "../read-audit.js";

/**
 * TABLE read endpoints. See Specification_Data_API.md §2.1.
 * VIEW/FUNCTION and mutations are later phases (5 and 4).
 */
export function registerDataTableRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { schema: string; resource: string } }>(
    "/api/:schema/table/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "GET");

      const permission = await context.effectivePermissions.resolve(
        dataPrincipal.roleIds,
        resource.id,
        "READ",
      );
      const readAudit = new ReadAudit(context, request, resource, dataPrincipal);
      const rawQuery = request.query as Record<string, unknown>;
      if (permission.action !== "ALLOW") {
        const error = new TotalBaseError("ACTION_DENIED", deniedMessage("READ", request.params.schema, request.params.resource));
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

      // Rows, count and the READ audit row (audit_read) in one
      // transaction: one statement_timeout (api.request_timeout_ms) and one
      // snapshot for both, and no data returned the log didn't record.
      const auditDetail = { fields: ast.fields, where: rawQuery["where"], search: ast.search };
      try {
        return await context.database.transaction(async (client) => {
          const { rows } = await client.query(compiled.sql, compiled.params);
          // Which flags each row met (Specification_Data_API.md §3.9) - their columns out of the rows.
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
    },
  );

  app.get<{ Params: { schema: string; resource: string; pk: string } }>(
    "/api/:schema/table/:resource/:pk",
    async (request, reply) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "GET");

      const permission = await context.effectivePermissions.resolve(
        dataPrincipal.roleIds,
        resource.id,
        "READ",
      );
      const readAudit = new ReadAudit(context, request, resource, dataPrincipal);
      if (permission.action !== "ALLOW") {
        const error = new TotalBaseError("ACTION_DENIED", deniedMessage("READ", request.params.schema, request.params.resource));
        await readAudit.failed("DENIED", { pk: request.params.pk }, error);
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
        value: request.params.pk,
      };
      // The grant's row filter goes as the row filter, not into the request's where: its paths are the
      // administrator's and need no field grant (Specification_Security.md §6.5) - as a list read has it.
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
      const auditDetail = { where: { [pkColumn]: { _eq: request.params.pk } }, pk: request.params.pk };
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
      // Its version, for an optimistic write's If-Match (Specification_Data_API.md §5.3) - never a field of the row.
      const { [ROW_VERSION_COLUMN]: version, ...row } = rows[0]!;
      if (typeof version === "string") reply.header("etag", `"${version}"`);
      return { data: row, ...(typeof version === "string" && { meta: { version } }) };
    },
  );
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
