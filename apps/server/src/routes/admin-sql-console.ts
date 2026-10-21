import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { reconcileCatalog } from "../catalog-refresh.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope, type JsonSchema } from "@totalbase/openapi";
import { adminDoc, arrayOf, DATE_TIME, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";

interface ExecuteBody {
  sql: string;
  transactional?: boolean;
}

/** A request body's documented shape: `{ data: <schema> }` (Data_API.md §2.5). */
const dataBody = (schema: JsonSchema) => ({ schema: dataEnvelope(schema) });

/** The `data` of a request body; a missing one, or one without its SQL, is a 400. */
function sqlOf<T extends { sql: string }>(requestBody: { data?: T } | undefined | null): T {
  const data = requestBody?.data;
  if (typeof data !== "object" || data === null || typeof data.sql !== "string") {
    throw new TotalBaseError("INVALID_QUERY", "The request body must be { \"data\": { \"sql\": \"...\" } }.");
  }
  return data;
}

/** Component schemas of this area - mirror @totalbase/sql-console's SqlExecuteResult / SqlHistoryEntry. */
const SQL_CONSOLE_SCHEMAS: Record<string, JsonSchema> = {
  SqlConsoleResult: object({
    status: { type: "string", enum: ["EXECUTED"], description: "A failed statement answers with the error envelope instead." },
    rows: arrayOf({ type: "object", additionalProperties: true, description: "One result row, keyed by its PostgreSQL column names, as is." }),
    rowCount: { type: "integer", description: "Rows the statement returned or affected - the real total, even when `rows` was truncated." },
    truncated: { type: "boolean", description: "`rows` was cut to sql_console.max_rows." },
    columns: arrayOf(object({ name: { type: "string" }, dataType: { type: "string", description: "PostgreSQL's format_type name, e.g. `integer`, `timestamp with time zone`." } })),
    statements: { ...arrayOf(object({
      command: { type: "string", description: "PostgreSQL's command tag: SELECT, INSERT, CREATE, ..." },
      rows: arrayOf({ type: "object", additionalProperties: true }),
      rowCount: { type: "integer" },
      truncated: { type: "boolean" },
      columns: arrayOf(object({ name: { type: "string" }, dataType: { type: "string" } })),
    })), description: "Every statement of the script, in order - the top-level rows, rowCount, truncated and columns are the last one's." },
    notices: arrayOf(object({
      severity: { type: "string" },
      message: { type: "string" },
      detail: { type: "string" },
      hint: { type: "string" },
      code: { type: "string", description: "SQLSTATE." },
    }, ["severity", "message"])),
    durationMs: { type: "integer" },
  }),
  SqlConsoleHistoryEntry: object({
    id: UUID,
    admin: { ...UUID, description: "The administrator who ran it." },
    sqlText: { type: "string" },
    status: { type: "string", enum: ["EXECUTED", "FAILED"] },
    durationMs: { type: ["integer", "null"] },
    errorMessage: { type: ["string", "null"] },
    createdAt: DATE_TIME,
  }),
};
const docs = (doc: Parameters<typeof adminDoc>[1]) => adminDoc("sql-console", { ...doc, schemas: SQL_CONSOLE_SCHEMAS });

/**
 * Raw admin SQL execution (Administration.md §5).
 * Deliberately bypasses the Query Engine and Permission
 * Resolver (Foundations.md §19) - admin auth is the only gate.
 */
export function registerAdminSqlConsoleRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  // sql_console.enabled off: nothing runs (execute or explain); history
  // stays readable and purgeable.
  // A personal access token (the MCP server's agent, a script) runs SQL
  // only with sql_console.token_access on - checked here, on the server,
  // so no client can skip it; a signed-in administrator needs only the
  // console itself on.
  async function assertEnabled(request: FastifyRequest) {
    if (!(await context.settings.get("sql_console.enabled"))) {
      throw new TotalBaseError("SQL_CONSOLE_DISABLED", "The SQL Console is turned off (Settings > SQL Console).");
    }
    if (request.adminToken && !(await context.settings.get("sql_console.token_access"))) {
      throw new TotalBaseError(
        "SQL_CONSOLE_DISABLED",
        "The SQL Console is turned off for API tokens - an administrator turns it on in Settings > SQL Console > Allow API tokens.",
      );
    }
  }

  // A failed statement answers with PostgreSQL's own diagnostics - DETAIL,
  // HINT, SQLSTATE, position (TotalBaseError.toAdminJSON) - on these two
  // routes only; every other route keeps the public shape (AGENTS.md §20,
  // Administration.md §5.2).
  function sendAdminError(reply: FastifyReply, error: unknown): FastifyReply {
    if (!(error instanceof TotalBaseError)) throw error;
    return reply.code(error.httpStatus).send({ errors: [error.toAdminJSON()] });
  }

  app.post<{ Body: { data?: ExecuteBody } }>("/admin/api/sql/execute", {
    preHandler,
    ...docs({
      summary: "Execute raw SQL",
      description:
        "Admin-only, intentional raw SQL: runs exactly the given script (several statements allowed) as TotalBase's PostgreSQL role, " +
        "bypassing the Query Engine and permissions - DDL and DML included. Every run, successful or failed, is kept in the history and " +
        "audited; the catalog is refreshed afterwards (catalog.auto_refresh_after_ddl). On failure the error envelope carries PostgreSQL's " +
        "own diagnostics: message, `detail`, `hint`, `sqlstate` and `position` (the 1-based character offset into `sql`), each when PostgreSQL gave it. 403 SQL_CONSOLE_DISABLED when sql_console.enabled is off, or for a personal access token while sql_console.token_access is off.",
      requestBody: dataBody(object({
        sql: { type: "string" },
        transactional: { type: "boolean", default: false, description: "Wrap the script in one transaction - rolled back as a whole on error." },
      }, ["sql"])),
      response: ok(ref("SqlConsoleResult")),
    }),
  }, async (request, reply) => {
    await assertEnabled(request);
    const { sql, transactional } = sqlOf(request.body);
    const admin = request.admin!;
    const startedAt = new Date();

    try {
      const result = await context.sqlConsole.execute(admin.id, {
        sql,
        transactional,
        maxRows: await context.settings.get("sql_console.max_rows"),
      });

      try {
        await context.audit.record(context.database, {
          requestId: request.id,
          principal: { type: "ADMIN", id: admin.id },
          ...(request.adminToken && { metadata: { token: request.adminToken } }),
          action: "SQL_EXECUTE",
          status: "EXECUTED",
          source: "admin",
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          sqlText: sql,
          startedAt,
          finishedAt: new Date(),
        });
        // The console's whole point is unrestricted DDL/DML - refresh
        // the catalog after every run rather than trying to sniff DDL
        // keywords out of arbitrary SQL text (Administration.md §5.5: "catalog
        // refresh after DDL"), unless catalog.auto_refresh_after_ddl is
        // off. Cheap enough for an admin-only, low-frequency tool.
        if (await context.settings.get("catalog.auto_refresh_after_ddl")) await reconcileCatalog(context);
      } catch {
        // best-effort; never mask a successful execution
      }

      return { data: result };
    } catch (error) {
      try {
        await context.audit.record(context.database, {
          requestId: request.id,
          principal: { type: "ADMIN", id: admin.id },
          ...(request.adminToken && { metadata: { token: request.adminToken } }),
          action: "SQL_EXECUTE",
          status: "FAILED",
          source: "admin",
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          sqlText: sql,
          error: error instanceof Error ? { message: error.message } : { message: String(error) },
          startedAt,
          finishedAt: new Date(),
        });
      } catch {
        // best-effort; never mask the original error
      }
      return sendAdminError(reply, error);
    }
  });

  app.post<{ Body: { data?: { sql: string } } }>("/admin/api/sql/explain", {
    preHandler,
    ...docs({
      summary: "Explain a statement's plan",
      description: "EXPLAIN (FORMAT JSON) of one statement - planned, not executed, and not kept in the history. 403 SQL_CONSOLE_DISABLED when sql_console.enabled is off, or for a personal access token while sql_console.token_access is off.",
      requestBody: dataBody(object({ sql: { type: "string" } }, ["sql"])),
      response: ok(object({
        plan: { type: "array", items: { type: "object", additionalProperties: true }, description: "PostgreSQL's EXPLAIN (FORMAT JSON) output, as is." },
      })),
    }),
  }, async (request, reply) => {
    await assertEnabled(request);
    const { sql } = sqlOf(request.body);
    try {
      return { data: { plan: await context.sqlConsole.explain(sql) } };
    } catch (error) {
      return sendAdminError(reply, error);
    }
  });

  app.get<{ Querystring: { admin?: string; limit?: string; offset?: string; search?: string } }>(
    "/admin/api/sql/history",
    {
      preHandler,
      ...docs({
        summary: "SQL Console history",
        description: "Every administrator's executions, newest first - one page of them; `meta.total` counts every match.",
        parameters: [
          { name: "admin", in: "query", schema: UUID, description: "Only this administrator's." },
          { name: "search", in: "query", schema: { type: "string" }, description: "Case-insensitive substring of the SQL text." },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        response: {
          status: "200",
          schema: object({ data: arrayOf(ref("SqlConsoleHistoryEntry")), meta: object({ total: { type: "integer", description: "Entries matching the filters, across every page." } }, ["total"]) }, ["data", "meta"]),
        },
      }),
    },
    async (request) => {
      const { entries, total } = await context.sqlConsole.listHistory(
        request.query.admin,
        request.query.limit ? Number.parseInt(request.query.limit, 10) : undefined,
        request.query.offset ? Number.parseInt(request.query.offset, 10) : undefined,
        request.query.search,
      );
      return { data: entries, meta: { total } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/sql/history/:id",
    {
      preHandler,
      ...docs({ summary: "One SQL Console history entry", pathParameters: { id: UUID_PARAM }, response: ok(ref("SqlConsoleHistoryEntry")) }),
    },
    async (request) => ({ data: await context.sqlConsole.getHistoryEntry(request.params.id) }),
  );

  // Manual purge - the admin picks a cutoff date, distinct from the
  // automatic retention job (sql_console.history_retention_days) that
  // applies the same purgeHistory() on a schedule. Audited like any other
  // admin action on history data: this deletes rows, not just reads them.
  app.delete<{ Querystring: { before: string } }>("/admin/api/sql/history", {
    preHandler,
    ...docs({
      summary: "Purge SQL Console history",
      description: "Deletes every administrator's entries created before `before` (audited). The automatic purge is sql_console.history_retention_days.",
      parameters: [{ name: "before", in: "query", required: true, schema: DATE_TIME, description: "Cutoff instant (or date)." }],
      response: ok(object({ deletedCount: { type: "integer" } })),
    }),
  }, async (request) => {
    const admin = request.admin!;
    const before = new Date(request.query.before);
    if (Number.isNaN(before.getTime())) {
      throw new TotalBaseError("INVALID_QUERY", "'before' must be a valid date.");
    }

    const deletedCount = await context.sqlConsole.purgeHistory(before);

    try {
      await context.audit.record(context.database, {
        requestId: request.id,
        principal: { type: "ADMIN", id: admin.id },
        ...(request.adminToken && { metadata: { token: request.adminToken } }),
        action: "SQL_HISTORY_PURGE",
        status: "EXECUTED",
        source: "admin",
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    } catch {
      // best-effort; never mask a successful purge
    }

    return { data: { deletedCount } };
  });
}
