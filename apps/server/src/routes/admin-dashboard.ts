import type { FastifyInstance } from "fastify";
import { getDatabaseSpace, getDatabaseSummary } from "@totalbase/pg-catalog";
import { resolveDayZone } from "@totalbase/database";
import { getOutboxStats } from "@totalbase/outbox";
import type { JsonSchema } from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, object, ok, UUID } from "../openapi-admin-docs.js";
import { insightsWindow } from "./admin-audit.js";

const ACTIVITY_DAYS = 14;
/** An event waiting longer than this for the outbox consumer is a backlog worth a look. */
const OUTBOX_BACKLOG_SECONDS = 5 * 60;

/** Something that needs an operator's attention - `key` names what, the portal words it and links it. */
type AttentionKey =
  | "outbox_failed"
  | "workflow_runs_failed"
  | "locked_accounts"
  | "missing_resources"
  | "pool_waiting"
  | "outbox_backlog"
  | "tokens_expiring"
  | "failed_sign_ins"
  | "backup_failed";
type AttentionItem = { key: AttentionKey; severity: "error" | "warning" | "info"; count: number };

const INT: JsonSchema = { type: "integer" };
const DASHBOARD_SCHEMA = object({
  kpis: object({
    people: { ...INT, description: "Active accounts that can sign in (system accounts left out)." },
    usableTokens: { ...INT, description: "Personal access tokens that still authenticate." },
    resources: object({ exposed: INT, total: INT }),
    actions24h: object({ total: INT, denied: INT, failed: INT }),
  }),
  attention: arrayOf(object({
    key: { type: "string" },
    severity: { type: "string", enum: ["error", "warning", "info"] },
    count: INT,
  })),
  activity: object({
    timeZone: { type: "string" },
    days: arrayOf(object({ day: { type: "string", format: "date" }, data: INT, access: INT, sql: INT, bulk: INT, other: INT })),
  }),
  trends: object({
    problems: { ...arrayOf(object({ day: { type: "string", format: "date" }, denied: INT, failed: INT })), description: "Denied and failed audit entries per day - the same days as `activity`." },
    workflowRuns: { ...arrayOf(object({ day: { type: "string", format: "date" }, succeeded: INT, failed: INT })), description: "Finished workflow runs per day, by the day they finished - the same days as `activity`." },
  }),
  topResources: arrayOf(object({ id: UUID, schema: { type: "string" }, name: { type: "string" }, type: { type: "string" }, count: INT })),
  system: object({
    postgres: object({ database: { type: "string" }, version: { type: "string" }, sizeBytes: INT, connections: INT, maxConnections: INT }),
    pool: object({ max: INT, total: INT, idle: INT, waiting: INT }),
    sessionsActive: INT,
    backups: { ...object({ lastCompletedAt: { type: ["string", "null"], format: "date-time" }, nextAt: { type: ["string", "null"], format: "date-time", description: "The schedule's next backup - null while scheduled backups are off." } }, ["lastCompletedAt", "nextAt"]), description: "Built-in backups (Administration.md §12)." },
    masterKey: object({ source: { type: "string", enum: ["ENV", "FILE"] }, path: { type: ["string", "null"], description: "FILE: the file holding it - back it up apart from the database." } }, ["source", "path"]),
    outbox: object({ pending: INT, oldestPendingSeconds: { type: ["number", "null"] } }),
    space: object({
      schemas: { ...arrayOf(object({ schema: { type: "string" }, bytes: INT })), description: "Tables and materialized views with their indexes and TOAST, per schema, largest first." },
      totalbase: { ...arrayOf(object({ table: { type: "string" }, bytes: INT })), description: "TotalBase's own tables, largest first." },
    }),
  }),
});

/**
 * The admin's home (Administration.md §1: "Dashboard"): what
 * needs attention, a few counts, 14 days of activity in the viewer's
 * zone, the busiest resources and the system's state. Orchestration
 * only - each number comes from the package that owns it.
 */
export function registerAdminDashboardRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.get<{ Querystring: { tz?: string; offset?: string } }>("/admin/api/dashboard", {
    preHandler,
    ...adminDoc("dashboard", {
      summary: "The admin dashboard",
      description:
        "Needs-attention items (only those with a count), the headline counts, 14 days of audit activity per category " +
        "grouped in `tz` (the viewer's IANA zone; `offset` - minutes east of UTC - when PostgreSQL doesn't know it), the " +
        "same days' denied/failed entries and finished workflow runs, the application's busiest resources over 7 days " +
        "(TotalBase's own tables left out), the database/pool state and what takes the database's space.",
      parameters: [
        { name: "tz", in: "query", required: false, schema: { type: "string" } },
        { name: "offset", in: "query", required: false, schema: { type: "integer" } },
      ],
      response: ok(DASHBOARD_SCHEMA),
    }),
  }, async (request) => {
    const window = insightsWindow({ ...request.query, days: String(ACTIVITY_DAYS) });
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const warningDays = await context.settings.get("api_keys.rotation_warning_days");
    const zone = await resolveDayZone(context.database, window.timeZone, window.utcOffsetMinutes);
    const [insights, people, usableTokens, expiringTokens, locked, resources, failedRuns, runsPerDay, outbox, postgres, space, sessionsActive, backups] = await Promise.all([
      context.auditInsights.dashboard(window),
      context.auth.users.countActivePeople(),
      context.usersApis.countUsable(),
      context.usersApis.countExpiringWithin(warningDays),
      context.auth.users.countLocked(),
      context.resourcesAdmin.summary(),
      context.workflowRuns.countFailedSince(since24h),
      context.workflowRuns.countFinishedPerDay(ACTIVITY_DAYS, zone),
      getOutboxStats(context.database),
      getDatabaseSummary(context.database),
      getDatabaseSpace(context.database),
      context.auth.sessions.countActive(),
      context.backups.summary(),
    ]);
    const pool = context.database.poolStats();

    // Most urgent first; only what has a count.
    const attention: AttentionItem[] = [
      { key: "backup_failed" as const, severity: "error" as const, count: backups.latestFailed ? 1 : 0 },
      { key: "outbox_failed" as const, severity: "error" as const, count: outbox.failed },
      { key: "workflow_runs_failed" as const, severity: "error" as const, count: failedRuns },
      { key: "locked_accounts" as const, severity: "warning" as const, count: locked },
      { key: "missing_resources" as const, severity: "warning" as const, count: resources.missing },
      { key: "pool_waiting" as const, severity: "warning" as const, count: pool.waiting },
      {
        key: "outbox_backlog" as const,
        severity: "warning" as const,
        count: (outbox.oldestPendingSeconds ?? 0) > OUTBOX_BACKLOG_SECONDS ? outbox.pending : 0,
      },
      { key: "tokens_expiring" as const, severity: "info" as const, count: expiringTokens },
      { key: "failed_sign_ins" as const, severity: "info" as const, count: insights.last24h.failedSignIns },
    ].filter((item) => item.count > 0);

    return {
      data: {
        kpis: {
          people,
          usableTokens,
          resources: { exposed: resources.exposed, total: resources.total },
          actions24h: { total: insights.last24h.actions, denied: insights.last24h.denied, failed: insights.last24h.failed },
        },
        attention,
        activity: { timeZone: insights.timeZone, days: insights.perDay },
        trends: { problems: insights.problemsPerDay, workflowRuns: runsPerDay },
        topResources: insights.topResources,
        system: {
          postgres,
          pool,
          sessionsActive,
          backups: { lastCompletedAt: backups.lastCompletedAt, nextAt: backups.nextAt },
          masterKey: context.masterKeyOrigin,
          outbox: { pending: outbox.pending, oldestPendingSeconds: outbox.oldestPendingSeconds },
          space,
        },
      },
    };
  });
}
