import type { FastifyInstance } from "fastify";
import { assertQueryFeatures, compileSelect, takeFlags, parseQuery, SchemaContext } from "@totalbase/query-engine";
import { TotalBaseError, deniedMessage } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { buildRowFilter, dataApiTimeout, loadPasswordColumns, protectedFieldDecision, userVariableResolver, withPasswordColumnsDenied } from "@totalbase/mutations";
import { resolveViewResource } from "@totalbase/resources";
import { loadQueryFeatures } from "../query-features.js";
import { ReadAudit } from "../read-audit.js";


/**
 * VIEW read endpoint. VIEW is READ-only in V1 (Foundations.md §11.5); reuses
 * the same query engine as TABLE reads (Data_API.md §2.1).
 */
export function registerDataViewRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { schema: string; resource: string } }>(
    "/api/:schema/view/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveViewResource(context, request.params.schema, request.params.resource);

      const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resource.id, "READ");
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
    },
  );
}
