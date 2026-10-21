import type { FastifyInstance } from "fastify";
import type { AuditAction, AuditLogFilter } from "@totalbase/audit";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { parseUserFilter } from "./user-filter.js";
import { dataEnvelope, type JsonSchema, type ParameterObject } from "@totalbase/openapi";
import { adminDoc, arrayOf, DATE_TIME, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";

/** `days` (default 30), `tz` (IANA name, default UTC) and `offset` - the viewer's UTC offset in minutes east, used when PostgreSQL doesn't know `tz`. */
export function insightsWindow(query: { days?: string; tz?: string; offset?: string }) {
  const days = query.days === undefined ? 30 : Number(query.days);
  if (!Number.isInteger(days)) throw new TotalBaseError("INVALID_QUERY", "days must be a whole number.");
  const utcOffsetMinutes = query.offset === undefined ? undefined : Number(query.offset);
  return { days, timeZone: query.tz?.trim() || "UTC", utcOffsetMinutes };
}



const INT: JsonSchema = { type: "integer" };
const TEXT_OR_NULL: JsonSchema = { type: ["string", "null"] };
const DAY: JsonSchema = { type: "string", format: "date" };
const COUNTS: JsonSchema = { type: "object", additionalProperties: INT };

/** Mirrors @totalbase/audit's AuditLogEntryRow (totalbase.logs). */
const AUDIT_SCHEMAS: Record<string, JsonSchema> = {
  AuditLogEntry: object({
    id: UUID,
    requestId: { type: "string", description: "Shared by every entry one HTTP request wrote." },
    principalType: { type: "string", enum: ["USER", "API_KEY", "ADMIN", "SYSTEM"] },
    principalId: { type: ["string", "null"], description: "A user id, or a token id for API_KEY." },
    session: TEXT_OR_NULL,
    resource: { type: ["string", "null"], format: "uuid", description: "The resource acted on; null for AUTH and other resource-less entries." },
    action: {
      type: "string",
      enum: ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE", "AUTH", "SQL_EXECUTE", "SQL_HISTORY_PURGE", "IMPORT", "EXPORT", "PRINT", "MAINTENANCE", "DDL", "AUDIT_PURGE"],
    },
    status: { type: "string", enum: ["DENIED", "EXECUTED", "FAILED"] },
    source: { type: "string", description: "Where it came from: admin, api, auth, workflow, ..." },
    ip: TEXT_OR_NULL,
    userAgent: TEXT_OR_NULL,
    fields: { description: "Fields requested (reads)." },
    whereClause: { description: "The request's filter, when there was one." },
    payload: { description: "The written row (the resulting/existing row, so it always carries the primary key)." },
    changes: { description: "An UPDATE's old and new value of each column it changed, the resource's excluded columns left out; null otherwise." },
    metadata: { description: "Event-specific details; `metadata.event` names access events (auth.login, user.roles_set, ...); an entry a workflow step wrote carries `workflow`, `workflowRun`, `workflowStep` and `workflowInitiator`." },
    sqlText: { type: ["string", "null"], description: "SQL Console entries only." },
    sqlParams: {},
    errorCode: TEXT_OR_NULL,
    sqlstate: TEXT_OR_NULL,
    errorMessage: TEXT_OR_NULL,
    errorDetail: TEXT_OR_NULL,
    errorHint: TEXT_OR_NULL,
    startedAt: DATE_TIME,
    finishedAt: DATE_TIME,
    durationMs: { type: "number" },
    createdAt: DATE_TIME,
  }),
  AuditLogSummary: object({
    byStatus: { ...COUNTS, description: "Ignores the request's own `status` filter." },
    byPrincipalType: { ...COUNTS, description: "Ignores the request's own `principal_type` filter." },
    byAction: { ...COUNTS, description: "Ignores the request's own `action` filter." },
  }),
  AuditSignInInsights: object({
    timeZone: { type: "string", description: "The zone the buckets were computed in - `tz`, or a fixed offset like UTC-03:00." },
    totals: object({ succeeded: INT, failed: INT }),
    perDay: { ...arrayOf(object({ day: DAY, succeeded: INT, failed: INT })), description: "Every day of the window, oldest first." },
    byWeekday: { ...arrayOf(INT), description: "Successful sign-ins, ISO weekday 1 (Monday) to 7." },
    byHour: { ...arrayOf(INT), description: "Successful sign-ins, hour 0-23." },
    failuresByReason: arrayOf(object({ reason: { type: "string" }, count: INT })),
    topUsers: arrayOf(object({ user: UUID, count: INT })),
    topFailures: arrayOf(object({ user: { type: ["string", "null"], format: "uuid" }, email: TEXT_OR_NULL, count: INT })),
    recentFailures: arrayOf(object({ at: DATE_TIME, email: TEXT_OR_NULL, user: { type: ["string", "null"], format: "uuid" }, reason: TEXT_OR_NULL, ip: TEXT_OR_NULL, event: { type: "string" } })),
    lockedNow: { ...INT, description: "Accounts locked right now." },
    activeSessions: INT,
    userAgents: { ...arrayOf(object({ userAgent: TEXT_OR_NULL, count: INT })), description: "Sessions opened in the window, by user agent." },
  }),
  AuditActivityInsights: object({
    timeZone: { type: "string" },
    totals: object({ actions: INT, writes: INT, denied: INT, failed: INT }),
    perDay: { ...arrayOf(object({ day: DAY, data: INT, access: INT, sql: INT, bulk: INT, other: INT })), description: "Entries per day and category." },
    writesPerDay: arrayOf(object({ day: DAY, create: INT, update: INT, delete: INT })),
    heatmap: { ...arrayOf(arrayOf(INT)), description: "[ISO weekday 1-7 minus 1][hour 0-23], every action." },
    bySource: arrayOf(object({ source: { type: "string" }, count: INT })),
    failures: { ...arrayOf(object({ code: { type: "string" }, count: INT, sample: TEXT_OR_NULL })), description: "Denied/failed entries by error code." },
    dataOut: {
      ...arrayOf(object({ resource: { type: ["string", "null"], format: "uuid" }, exported: INT, imported: INT, printed: INT, operations: INT })),
      description: "Rows moved by Export/Import/Print per resource (null: one deleted since).",
    },
    topResources: arrayOf(object({ resource: UUID, count: INT })),
    topActions: arrayOf(object({ action: { type: "string" }, count: INT })),
    topUsers: { ...arrayOf(object({ user: UUID, count: INT })), description: "Most active users (an API token's entries count for its owner); top 10." },
  }),
  AuditExclusions: object(
    { excludedFields: { ...arrayOf({ type: "string" }), description: "Columns kept out of the audit log - every write's `payload` and an UPDATE's `changes` - in column order; [] = every column is recorded." } },
    ["excludedFields"],
  ),
};

const query = (name: string, description: string, schema: JsonSchema = { type: "string" }): ParameterObject => ({ name, in: "query", required: false, schema, description });

const INSIGHTS_PARAMETERS: ParameterObject[] = [
  query("days", "The last N days, today included: 1-366, default 30.", { type: "integer", minimum: 1, maximum: 366 }),
  query("tz", "IANA time zone the buckets are computed in (default UTC)."),
  query("offset", "The viewer's UTC offset in minutes east (UTC-3 = -180), used when PostgreSQL doesn't know `tz`.", { type: "integer" }),
];

/** AuditLogQuery as documented query parameters - shared by /audit/logs and its summary. */
const LOG_FILTER_PARAMETERS: ParameterObject[] = [
  query("resource", "A resource id.", UUID),
  query("principal_type", "USER, API_KEY, ADMIN or SYSTEM."),
  query("principal", "A user id, or a token id."),
  query("action", "One action or a comma-separated list (CREATE,UPDATE,DELETE,...)."),
  query("status", "One status or a comma-separated list (DENIED, EXECUTED, FAILED)."),
  query("request_id", "Every entry of one HTTP request."),
  query("pk_column", "With `pk_value` (and `resource`): one row's own history, matched on the entry's payload."),
  query("pk_value", "See `pk_column`."),
  query("event", "Access event names, comma-separated (`metadata.event`); `prefix.*` matches by prefix, e.g. `permission.*`."),
  query("role_change", "A role id: entries that added or removed it (access review).", UUID),
  query("workflow_run", "A workflow run id: the entries its steps wrote (`metadata.workflowRun`).", UUID),
  query("since", "Created at or after (ISO 8601).", DATE_TIME),
  query("until", "Created at or before (ISO 8601).", DATE_TIME),
  query("before", "Created strictly before (ISO 8601) - the nearest earlier entry.", DATE_TIME),
];

interface AuditLogQuery {
  resource?: string;
  principal_type?: string;
  principal?: string;
  /** One action or a comma-separated list (a category). */
  action?: string;
  /** One status or a comma-separated list. */
  status?: string;
  /** Every entry of one HTTP request. */
  request_id?: string;
  /** One row's own history (admin's "View history") - see AuditLogFilter's own doc comment. Both required together. */
  pk_column?: string;
  pk_value?: string;
  /** Access event names, comma-separated; "prefix.*" matches by prefix (e.g. "permission.*"). */
  event?: string;
  /** A role id - entries that added or removed it (access review). */
  role_change?: string;
  /** A workflow run id - the entries its steps wrote. */
  workflow_run?: string;
  since?: string;
  until?: string;
  /** Strictly-before lookup (RecordHistoryPanel.vue's own on-demand "nearest earlier entry for this record" query) - see AuditLogFilter's own `strictlyBefore` doc comment. */
  before?: string;
  limit?: string;
  offset?: string;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function date(name: string, value: string | undefined): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TotalBaseError("INVALID_QUERY", `${name} must be an ISO 8601 date-time, got "${value}".`);
  }
  return parsed;
}

function nonNegativeInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new TotalBaseError("INVALID_QUERY", `${name} must be a non-negative integer, got "${value}".`);
  return Number.parseInt(value, 10);
}

function uuid(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TotalBaseError("INVALID_QUERY", `${name} must be a UUID, got "${value}".`);
  }
  return value;
}

/** Rejects malformed values here, at the edge, instead of letting them reach PostgreSQL as an opaque error. */
function toFilter(query: AuditLogQuery): AuditLogFilter {
  return {
    resourceId: query.resource,
    principalType: query.principal_type,
    principalId: query.principal,
    action: list(query.action),
    status: list(query.status),
    requestId: query.request_id,
    payloadPkColumn: query.pk_column,
    payloadPkValue: query.pk_value,
    event: list(query.event),
    roleChange: query.role_change,
    workflowRun: uuid("workflow_run", query.workflow_run),
    since: date("since", query.since),
    until: date("until", query.until),
    strictlyBefore: date("before", query.before),
    limit: nonNegativeInt("limit", query.limit),
    offset: nonNegativeInt("offset", query.offset),
  };
}

/**
 * Audit browsing and per-resource audit-field configuration
 * (Administration.md §1: "Audit").
 */
export function registerAdminAuditRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);
  const schemas = AUDIT_SCHEMAS;
  const RESOURCE = { resource: { ...UUID_PARAM, description: "The resource's TotalBase id." } };

  // "activity" is the same log, just a small default page for a feed view -
  // there is no distinct underlying dataset (Administration.md §1
  // does not further define the distinction; AGENTS.md section 27).
  // Users → Insights: aggregates computed by PostgreSQL (AuditInsightsService)
  // in the viewer's time zone. `days` 1-366 (default 30), `tz` an IANA name,
  // `offset` the fallback when PostgreSQL doesn't know that name.
  app.get<{ Querystring: { days?: string; tz?: string; offset?: string } }>("/admin/api/audit/insights/sign-ins", {
    preHandler,
    ...adminDoc("audit", {
      summary: "Sign-in insights",
      description: "Sign-in attempts (API, portal, OAuth) over the window, aggregated by PostgreSQL in the viewer's zone, plus the current locked accounts, active sessions and recent sessions' user agents.",
      parameters: INSIGHTS_PARAMETERS,
      response: ok(ref("AuditSignInInsights")),
      schemas,
    }),
  }, async (request) => {
    const window = insightsWindow(request.query);
    const [signIns, lockedNow, activeSessions, userAgents] = await Promise.all([
      context.auditInsights.signIns(window),
      context.auth.users.countLocked(),
      context.auth.sessions.countActive(),
      context.auth.sessions.userAgentsSince(window.days),
    ]);
    return { data: { ...signIns, lockedNow, activeSessions, userAgents } };
  });

  // `user`: one user's activity - their own entries and those made through
  // their API tokens (a token is its own principal). Omitted: everyone's.
  app.get<{ Querystring: { days?: string; tz?: string; offset?: string; user?: string } }>("/admin/api/audit/insights/activity", {
    preHandler,
    ...adminDoc("audit", {
      summary: "Activity insights",
      description: "Audit activity over the window, aggregated by PostgreSQL in the viewer's zone. With `user`: that user's entries and those of their API tokens.",
      parameters: [...INSIGHTS_PARAMETERS, query("user", "A user id: only their activity.", UUID)],
      response: ok(ref("AuditActivityInsights")),
      schemas,
    }),
  }, async (request) => {
    const window = insightsWindow(request.query);
    const user = parseUserFilter(request.query.user);
    const principalIds = user ? [user, ...(await context.usersApis.listForUser(user)).map((t) => t.id)] : undefined;
    const { topPrincipals, ...activity } = await context.auditInsights.activity({ ...window, principalIds });

    // "Most active users": an API token's entries count for its owner.
    const tokenOwners = new Map(
      (await context.usersApis.listByIds(topPrincipals.filter((p) => p.principalType === "API_KEY").map((p) => p.principalId)))
        .map((t) => [t.id, t.user]),
    );
    const byUser = new Map<string, number>();
    for (const p of topPrincipals) {
      const owner = p.principalType === "API_KEY" ? tokenOwners.get(p.principalId) : p.principalId;
      if (owner) byUser.set(owner, (byUser.get(owner) ?? 0) + p.count);
    }
    const topUsers = [...byUser.entries()].map(([id, count]) => ({ user: id, count })).sort((a, b) => b.count - a.count).slice(0, 10);
    return { data: { ...activity, topUsers } };
  });

  app.get("/admin/api/audit/activity", {
    preHandler,
    ...adminDoc("audit", {
      summary: "Recent activity",
      description: "The 20 newest audit entries - the same log as /audit/logs, unfiltered.",
      response: ok(arrayOf(ref("AuditLogEntry"))),
      schemas,
    }),
  }, async () => ({
    data: await context.auditQuery.recentActivity(),
  }));

  app.get<{ Querystring: AuditLogQuery }>("/admin/api/audit/logs", {
    preHandler,
    ...adminDoc("audit", {
      summary: "Search the audit log",
      description: "Newest first. Filters combine with AND. `meta.total` counts at most 10 000 matches; `meta.totalCapped` says there are more.",
      parameters: [
        ...LOG_FILTER_PARAMETERS,
        query("limit", "Page size, default 50, at most 500.", { type: "integer", minimum: 0 }),
        query("offset", "Rows to skip.", { type: "integer", minimum: 0 }),
      ],
      response: {
        status: "200",
        schema: {
          type: "object",
          required: ["data", "meta"],
          properties: {
            data: arrayOf(ref("AuditLogEntry")),
            meta: object({ total: INT, totalCapped: { type: "boolean" } }),
          },
        },
      },
      schemas,
    }),
  }, async (request) => {
    const { data, total, totalCapped } = await context.auditQuery.list(toFilter(request.query));
    return { data, meta: { total, totalCapped } };
  });

  // Faceted counts for the Logs panel - same filters as /audit/logs.
  app.get<{ Querystring: AuditLogQuery }>("/admin/api/audit/logs/summary", {
    preHandler,
    ...adminDoc("audit", {
      summary: "Audit log facet counts",
      description: "Entry counts per status, principal type and action under the same filters as /audit/logs - each facet ignores its own filter.",
      parameters: LOG_FILTER_PARAMETERS,
      response: ok(ref("AuditLogSummary")),
      schemas,
    }),
  }, async (request) => ({
    data: await context.auditQuery.summary(toFilter(request.query)),
  }));

  app.get<{ Params: { id: string } }>(
    "/admin/api/audit/logs/:id",
    {
    preHandler,
    ...adminDoc("audit", {
      summary: "Get an audit entry",
      pathParameters: { id: { ...UUID_PARAM, description: "The entry's id." } },
      response: ok(ref("AuditLogEntry")),
      schemas,
    }),
  },
    async (request) => ({ data: await context.auditQuery.get(request.params.id) }),
  );

  app.get<{ Params: { resource: string } }>(
    "/admin/api/resources/:resource/audit",
    {
    preHandler,
    ...adminDoc("audit", {
      summary: "A resource's audit exclusions",
      description:
        "Every CREATE/UPDATE/DELETE is audited whole: the row in `payload`, and an UPDATE's old and new value of every column " +
        "it changed in `changes`. These are the columns kept out of both (password and protected columns always are).",
      pathParameters: RESOURCE,
      response: ok(ref("AuditExclusions")),
      schemas,
    }),
  },
    async (request) => {
      await context.resourcesAdmin.get(request.params.resource);
      return { data: { excludedFields: await context.auditExclusions.list(request.params.resource) } };
    },
  );

  app.put<{ Params: { resource: string }; Body: { data?: { excludedFields?: unknown } } | null }>(
    "/admin/api/resources/:resource/audit",
    {
    preHandler,
    ...adminDoc("audit", {
      summary: "Set a resource's audit exclusions",
      description: "Replaces the whole list; every name must be one of the resource's columns (400 INVALID_QUERY otherwise). [] records every column.",
      pathParameters: RESOURCE,
      requestBody: { schema: dataEnvelope(ref("AuditExclusions")) },
      response: ok(ref("AuditExclusions")),
      schemas,
    }),
  },
    async (request) => {
      const fields = request.body?.data?.excludedFields;
      if (!Array.isArray(fields) || !fields.every((field): field is string => typeof field === "string")) {
        throw new TotalBaseError("INVALID_QUERY", '"excludedFields" must be an array of column names.');
      }
      await context.resourcesAdmin.get(request.params.resource);
      await context.auditExclusions.set(request.params.resource, fields);
      return { data: { excludedFields: await context.auditExclusions.list(request.params.resource) } };
    },
  );

}
