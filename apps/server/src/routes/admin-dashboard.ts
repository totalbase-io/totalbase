import type { QueryRoleProblem } from "@totalbase/dashboards";
import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { getConnectionSecurity, getDatabaseSpace, getDatabaseSummary, getMaintenanceAttention } from "@totalbase/pg-catalog";
import { resolveDayZone } from "@totalbase/database";
import { getOutboxStats } from "@totalbase/outbox";
import type { JsonSchema } from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, object, ok, UUID } from "../openapi-admin-docs.js";
import { currentLockdown } from "../lockdown.js";
import { TOTALBASE_VERSION } from "../version.js";
import { insightsWindow } from "./admin-audit.js";
import { certificateStatus, PublicUrlMonitor } from "../public-url-check.js";

/** The windows the charts offer, in days - the widest one when none is asked for. */
const ACTIVITY_WINDOWS = [7, 14, 30];
const ACTIVITY_DAYS = 30;
/** An event waiting longer than this for the outbox consumer is a backlog worth a look. */
const OUTBOX_BACKLOG_SECONDS = 5 * 60;
/** Connections at or above this share of max_connections leave little room for anything else on the server. */
const CONNECTIONS_HIGH_SHARE = 0.8;
/** At or above this one, the next connection may be refused: an error, no longer a warning. */
const CONNECTIONS_CRITICAL_SHARE = 0.95;

/** How worrying the server's open connections are against its max_connections - null below the first threshold. */
export function connectionsSeverity(connections: number, maxConnections: number): "error" | "warning" | null {
  if (connections >= maxConnections * CONNECTIONS_CRITICAL_SHARE) return "error";
  return connections >= maxConnections * CONNECTIONS_HIGH_SHARE ? "warning" : null;
}
/** A public URL on this machine: http there is a development instance, not a page sent over a network. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** Whether `mfa.required` leaves the Administrators role out (Security.md §2.17): no one, or roles that don't include it. */
async function administratorsWithoutMfa(context: AppContext): Promise<boolean> {
  const [policy, roles] = await Promise.all([context.settings.get("mfa.required"), context.settings.get("mfa.required_roles")]);
  if (policy === "EVERYONE") return false;
  if (policy !== "ROLES") return true;
  return !roles.includes(await context.roles.getAdministratorsRoleId());
}

/**
 * How many of the self-registration role's UPDATE and DELETE grants have no row filter - anyone who signs up can
 * change or remove every row of those resources. 0 while self-registration is off or gives no role.
 */
async function registrationUnfilteredWrites(context: AppContext): Promise<number> {
  const [enabled, role] = await Promise.all([context.settings.get("auth.registration_enabled"), context.settings.get("auth.registration_default_role")]);
  return enabled && role ? context.permissions.countUnfilteredWrites(role) : 0;
}

/** A request from a proxy the server doesn't trust, seen within this, is worth a warning. */
const UNTRUSTED_PROXY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many of the window's backups the admin lists - the newest. */
const RECENT_BACKUPS = 5;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

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
  | "tokens_refused"
  | "backup_failed"
  | "smtp_not_configured"
  | "backups_off"
  | "connections_high"
  | "invalid_indexes"
  | "tables_with_dead_rows"
  | "executions_failed"
  | "master_key_file"
  | "public_url_http"
  | "rate_limit_off"
  | "user_rate_limit_off"
  | "certificate_invalid"
  | "certificate_expiring"
  | "security_headers_missing"
  | "public_url_unreachable"
  | "untrusted_proxy"
  | "lockout_off"
  | "mfa_not_required"
  | "registration_unfiltered_writes"
  | "definer_functions_exposed"
  | "postgres_superuser"
  | "postgres_role_privileges"
  | "postgres_password_md5"
  | "postgres_tls_off"
  | "dashboards_query_role";
/** A widget query role's problem as Status names it - PostgreSQL's terms, as for TotalBase's own role. */
const QUERY_ROLE_PROBLEM_TERMS: Record<QueryRoleProblem, string> = {
  missing: "no such role",
  own_role: "TotalBase's own role",
  superuser: "SUPERUSER",
  not_granted: "not granted to TotalBase's role",
  bypassrls: "BYPASSRLS",
  reads_totalbase: "USAGE on schema totalbase",
};
/** What an instance can have on, in the order the admin lists it; each is its settings page's switch (SMTP: its host and sender). */
const SERVICE_SWITCHES = {
  backups: "backups.enabled",
  s3: "s3.enabled",
  audit: "audit.enabled",
  openapi: "openapi.enabled",
  graphql: "graphql.enabled",
  realtime: "realtime.enabled",
  mcp: "mcp.enabled",
  sql_console: "sql_console.enabled",
} as const;
type AttentionItem = { key: AttentionKey; severity: "error" | "warning" | "info"; count: number; detail?: string[] };

const INT: JsonSchema = { type: "integer" };
const NULLABLE_INSTANT: JsonSchema = { type: ["string", "null"], format: "date-time" };
const DASHBOARD_SCHEMA = object({
  instance: object({
    version: { type: "string", description: "This build's TotalBase version." },
    environment: { type: "string", description: "NODE_ENV." },
    publicUrl: { type: "string", description: "The canonical external URL in effect (`system.public_url`, else TOTALBASE_PUBLIC_URL)." },
    uptimeSeconds: { ...INT, description: "How long this server process has been running." },
    lockdown: {
      ...object({
        active: { type: "boolean" },
        readOnly: { type: "boolean", description: "`lockdown.mode` is READ_ONLY." },
        endsAt: { ...NULLABLE_INSTANT, description: "When a running window ends by itself - null when it is on until turned off, or when inactive." },
        startsAt: { ...NULLABLE_INSTANT, description: "When the next scheduled window starts - null while one runs, or when none is ahead." },
      }, ["active", "readOnly", "endsAt", "startsAt"]),
      description: "The lockdown now (Security.md §2.21).",
    },
  }),
  kpis: object({
    people: { ...INT, description: "Active accounts that can sign in (system accounts left out)." },
    usableTokens: { ...INT, description: "Personal access tokens that still authenticate." },
    resources: object({ exposed: INT, total: INT }),
    actions24h: object({ total: INT, previous: { ...INT, description: "The 24 hours before them." }, denied: INT, failed: INT }),
    sessionsActive: { ...INT, description: "Sessions that still authenticate." },
    workflowRuns24h: { ...object({ succeeded: INT, failed: INT }), description: "Workflow runs finished in the last 24 hours." },
  }),
  services: {
    ...arrayOf(object({
      key: { type: "string", enum: ["smtp", ...Object.keys(SERVICE_SWITCHES)] },
      state: { type: "string", enum: ["ON", "OFF", "NOT_CONFIGURED"], description: "NOT_CONFIGURED: SMTP without its host or sender." },
    })),
    description: "What this instance has turned on - each one's own switch in the settings.",
  },
  attention: arrayOf(object({
    key: { type: "string" },
    severity: { type: "string", enum: ["error", "warning", "info"] },
    count: INT,
    detail: { type: "array", items: { type: "string" }, description: "What the item is about, when its count isn't enough - the names of the security headers missing." },
  }, ["key", "severity", "count"])),
  activity: object({
    timeZone: { type: "string" },
    data: {
      ...arrayOf(object({ day: { type: "string", format: "date" }, create: INT, update: INT, delete: INT, read: INT, execute: INT, bulk: INT })),
      description: "The Data API's audit entries per day, by what was done; `bulk`: Import, Export and Print. A read counts only where it is audited (`resources.audit_read`).",
    },
    admin: {
      ...arrayOf(object({ day: { type: "string", format: "date" }, access: INT, config: INT, schema: INT, sql: INT, other: INT })),
      description: "Every other audit entry per day - the same days - by area: access, configuration, schema changes, the SQL Console, other.",
    },
    problems: { ...object({ data: INT, admin: INT }), description: "Denied and failed entries over the window, on each side." },
  }),
  trends: object({
    workflowRuns: { ...arrayOf(object({ day: { type: "string", format: "date" }, succeeded: INT, failed: INT })), description: "Finished workflow runs per day, by the day they finished - the same days as `activity`." },
  }),
  topResources: arrayOf(object({ id: UUID, schema: { type: "string" }, name: { type: "string" }, type: { type: "string" }, count: INT })),
  system: object({
    postgres: object({ database: { type: "string" }, version: { type: "string" }, sizeBytes: INT, connections: INT, maxConnections: INT, startedAt: { type: "string", format: "date-time", description: "When the PostgreSQL server started." } }),
    pool: object({ max: INT, total: INT, idle: INT, waiting: INT }),
    backups: { ...object({ enabled: { type: "boolean", description: "`backups.enabled`." }, lastCompletedAt: { type: ["string", "null"], format: "date-time" }, nextAt: { type: ["string", "null"], format: "date-time", description: "The schedule's next backup - null while scheduled backups are off." },
      recent: {
        ...arrayOf(object({
          id: UUID,
          status: { type: "string", enum: ["PENDING", "RUNNING", "COMPLETED", "FAILED"] },
          trigger: { type: "string", enum: ["SCHEDULED", "MANUAL"] },
          destination: { type: "string", enum: ["LOCAL", "S3"] },
          sizeBytes: { type: ["integer", "null"] },
          error: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
          startedAt: NULLABLE_INSTANT,
          completedAt: NULLABLE_INSTANT,
        }, ["id", "status", "trigger", "destination", "sizeBytes", "error", "createdAt", "startedAt", "completedAt"])),
        description: "The 5 newest backups queued within the last `days` days, whatever their status, newest first.",
      } }, ["enabled", "lastCompletedAt", "nextAt", "recent"]), description: "Built-in backups (Administration.md §12)." },
    masterKey: object({ source: { type: "string", enum: ["ENV", "FILE"] }, path: { type: ["string", "null"], description: "FILE: the file holding it - back it up apart from the database." } }, ["source", "path"]),
    outbox: object({ pending: INT, oldestPendingSeconds: { type: ["number", "null"] } }),
    executions: { ...object({ pending: INT, running: INT, failed: INT }), description: "Asynchronous executions of every type: waiting, running, and failed in the last 24 hours." },
    maintenance: object({ running: { type: "boolean", description: "A maintenance batch is queued or running." } }),
    space: object({
      schemas: {
        ...arrayOf(object({ schema: { type: "string" }, bytes: INT, tables: arrayOf(object({ table: { type: "string" }, bytes: INT })) })),
        description: "Tables and materialized views with their indexes and TOAST, per schema, largest first - each with its total and its 10 largest tables.",
      },
    }),
  }),
});

/**
 * The admin's home (Administration.md §1.6): what this instance is,
 * what needs attention, a few counts, a window of days of activity in the viewer's
 * zone, the busiest resources and the system's state. Orchestration
 * only - each number comes from the package that owns it.
 */
export function registerAdminDashboardRoutes(app: FastifyInstance, context: AppContext, publicUrlMonitor = new PublicUrlMonitor()): void {
  const preHandler = requireAdmin(context);

  app.get<{ Querystring: { days?: string; tz?: string; offset?: string } }>("/admin/api/dashboard", {
    preHandler,
    ...adminDoc("dashboard", {
      summary: "The admin dashboard",
      description:
        "What this instance is (version, environment, public URL, uptime, lockdown) and has turned on, needs-attention items (only those with a count), the headline counts, `days` days of audit activity (7, 14 or 30; 30 by default) - the Data API's by what was done, the administration's by area - " +
        "grouped in `tz` (the viewer's IANA zone; `offset` - minutes east of UTC - when PostgreSQL doesn't know it), the " +
        "same days' denied/failed entries and finished workflow runs, the application's busiest resources over 7 days " +
        "(TotalBase's own tables left out), the database/pool state and what takes the database's space.",
      parameters: [
        { name: "days", in: "query", required: false, schema: { type: "integer", enum: ACTIVITY_WINDOWS, default: ACTIVITY_DAYS } },
        { name: "tz", in: "query", required: false, schema: { type: "string" } },
        { name: "offset", in: "query", required: false, schema: { type: "integer" } },
      ],
      response: ok(DASHBOARD_SCHEMA),
    }),
  }, async (request) => {
    const days = request.query.days === undefined ? ACTIVITY_DAYS : Number(request.query.days);
    if (!ACTIVITY_WINDOWS.includes(days)) throw new TotalBaseError("INVALID_QUERY", `days must be one of ${ACTIVITY_WINDOWS.join(", ")}.`);
    const window = insightsWindow({ ...request.query, days: String(days) });
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const warningDays = await context.settings.get("api_keys.rotation_warning_days");
    const zone = await resolveDayZone(context.database, window.timeZone, window.utcOffsetMinutes);
    const [insights, people, usableTokens, expiringTokens, locked, resources, runs24h, runsPerDay, outbox, postgres, space, sessionsActive, backups, backupsEnabled, maintenance, executions, maintenanceBatch, lockdown, publicUrl, smtpHost, smtpFrom, latestBackups, connection, realtimeEnabled, rateLimitEnabled, perUserPerMinute, trustProxy, trustedProxies, lockoutAttempts, administratorsUncovered, registrationWrites, queryRoleProblems] = await Promise.all([
      context.auditInsights.dashboard(window),
      context.auth.users.countActivePeople(),
      context.usersApis.countUsable(),
      context.usersApis.countExpiringWithin(warningDays),
      context.auth.users.countLocked(),
      context.resourcesAdmin.summary(),
      context.workflowRuns.countFinishedSince(since24h),
      context.workflowRuns.countFinishedPerDay(days, zone),
      getOutboxStats(context.database),
      getDatabaseSummary(context.database),
      getDatabaseSpace(context.database),
      context.auth.sessions.countActive(),
      context.backups.summary(),
      context.settings.get("backups.enabled"),
      getMaintenanceAttention(context.database),
      context.executions.stats(since24h),
      context.maintenance.activeBatchId(),
      currentLockdown(context),
      context.auth.mailer.publicUrl(),
      context.settings.get("smtp.host"),
      context.settings.get("smtp.from"),
      context.backups.list(RECENT_BACKUPS),
      getConnectionSecurity(context.database),
      context.settings.get("realtime.enabled"),
      context.settings.get("security.rate_limit_enabled"),
      context.settings.get("security.rate_limit_per_user_per_minute"),
      context.settings.get("security.trust_proxy"),
      context.settings.get("security.trusted_proxies"),
      context.settings.get("auth.lockout_max_attempts"),
      administratorsWithoutMfa(context),
      registrationUnfilteredWrites(context),
      context.dashboardsAdmin.queryRoleProblems(),
    ]);
    const pool = context.database.poolStats();
    const windowStart = Date.now() - days * 24 * 60 * 60 * 1000;
    const recentBackups = latestBackups
      .filter((backup) => backup.createdAt.getTime() >= windowStart)
      .map(({ id, status, trigger, destination, sizeBytes, error, createdAt, startedAt, completedAt }) => ({ id, status, trigger, destination, sizeBytes, error, createdAt, startedAt, completedAt }));
    const switches = await Promise.all(
      Object.entries(SERVICE_SWITCHES).map(async ([key, setting]) => ({ key, state: (await context.settings.get(setting)) ? "ON" : "OFF" })),
    );

    const connectionsLevel = connectionsSeverity(postgres.connections, postgres.maxConnections);
    // The instance seen from outside, through its public URL - the last check, refreshed in the background (§1.6).
    const outside = publicUrlMonitor.current(publicUrl);
    const certificate = outside ? certificateStatus(outside.certificate) : null;
    // REPLICATION is Realtime's own need (Data_API.md §16.1): only while it is off is it one too many.
    const extraPrivileges = connection.privileges.filter((privilege) => privilege !== "REPLICATION" || !realtimeEnabled);
    // Most urgent first; only what has a count.
    const attention: AttentionItem[] = [
      { key: "backup_failed" as const, severity: "error" as const, count: backups.latestFailed ? 1 : 0 },
      { key: "certificate_invalid" as const, severity: "error" as const, count: certificate === "invalid" ? 1 : 0 },
      { key: "outbox_failed" as const, severity: "error" as const, count: outbox.failed },
      { key: "workflow_runs_failed" as const, severity: "error" as const, count: runs24h.failed },
      { key: "executions_failed" as const, severity: "error" as const, count: executions.failed },
      { key: "invalid_indexes" as const, severity: "warning" as const, count: maintenance.invalidIndexes },
      { key: "locked_accounts" as const, severity: "warning" as const, count: locked },
      { key: "missing_resources" as const, severity: "warning" as const, count: resources.missing },
      { key: "pool_waiting" as const, severity: "warning" as const, count: pool.waiting },
      {
        key: "connections_high" as const,
        severity: connectionsLevel ?? ("warning" as const),
        count: connectionsLevel ? postgres.connections : 0,
      },
      {
        key: "outbox_backlog" as const,
        severity: "warning" as const,
        count: (outbox.oldestPendingSeconds ?? 0) > OUTBOX_BACKLOG_SECONDS ? outbox.pending : 0,
      },
      // A revoked, expired or out-of-place token still being presented (Security.md §11.6): a program nobody updated, or a leaked secret.
      { key: "tokens_refused" as const, severity: "warning" as const, count: insights.last24h.refusedTokens },
      // Configuration: what this instance can't do, or isn't protected against, as it is set up.
      { key: "backups_off" as const, severity: "warning" as const, count: backupsEnabled ? 0 : 1 },
      { key: "smtp_not_configured" as const, severity: "warning" as const, count: smtpHost && smtpFrom ? 0 : 1 },
      // Security: how the instance and its connection to PostgreSQL are set up (Administration.md §1.6).
      // Its count is the days left - the portal says "expires in N days".
      { key: "certificate_expiring" as const, severity: "warning" as const, count: certificate === "expiring" ? Math.max(1, Math.ceil((outside!.certificate!.validTo!.getTime() - Date.now()) / 86_400_000)) : 0 },
      { key: "security_headers_missing" as const, severity: "warning" as const, count: outside?.missingHeaders.length ?? 0, ...(outside && { detail: outside.missingHeaders }) },
      { key: "public_url_http" as const, severity: "warning" as const, count: publicUrl.startsWith("http://") && !isLocalUrl(publicUrl) ? 1 : 0 },
      // A proxy forwarding requests the server doesn't trust: every caller has its address (Administration.md §7.8).
      { key: "untrusted_proxy" as const, severity: "warning" as const, count: (app.untrustedProxySeenAt ?? 0) > Date.now() - UNTRUSTED_PROXY_WINDOW_MS ? 1 : 0 },
      { key: "user_rate_limit_off" as const, severity: "warning" as const, count: perUserPerMinute > 0 ? 0 : 1 },
      // The per-address limit is off by default on purpose: behind a proxy nobody trusts every caller has the proxy's
      // address (§7.8). Once a proxy is trusted, leaving it off is an oversight.
      { key: "rate_limit_off" as const, severity: "warning" as const, count: !rateLimitEnabled && (trustProxy || trustedProxies.length > 0) ? 1 : 0 },
      { key: "lockout_off" as const, severity: "warning" as const, count: lockoutAttempts === 0 ? 1 : 0 },
      { key: "registration_unfiltered_writes" as const, severity: "warning" as const, count: registrationWrites },
      { key: "postgres_superuser" as const, severity: "warning" as const, count: connection.superuser ? 1 : 0 },
      { key: "postgres_role_privileges" as const, severity: "warning" as const, count: extraPrivileges.length, detail: extraPrivileges },
      { key: "postgres_password_md5" as const, severity: "warning" as const, count: connection.passwordEncryption === "scram-sha-256" ? 0 : 1 },
      { key: "postgres_tls_off" as const, severity: "warning" as const, count: connection.ssl || connection.privateNetwork ? 0 : 1 },
      // The widget query role (Dashboards.md §2.10): one that can't be used stops every widget; one that can bypass Row
      // Level Security or reach the totalbase schema protects less than it seems. In PostgreSQL's terms.
      { key: "dashboards_query_role" as const, severity: "warning" as const, count: queryRoleProblems.length, detail: queryRoleProblems.map((problem) => QUERY_ROLE_PROBLEM_TERMS[problem]) },
      { key: "tables_with_dead_rows" as const, severity: "info" as const, count: maintenance.tablesWithDeadRows },
      // A generated key file (Foundations.md §15) is lost with the data directory unless it is backed up apart.
      { key: "master_key_file" as const, severity: "info" as const, count: context.masterKeyOrigin.source === "FILE" ? 1 : 0 },
      { key: "tokens_expiring" as const, severity: "info" as const, count: expiringTokens },
      { key: "public_url_unreachable" as const, severity: "info" as const, count: outside !== null && !outside.reachable ? 1 : 0 },
      { key: "mfa_not_required" as const, severity: "info" as const, count: administratorsUncovered ? 1 : 0 },
      { key: "definer_functions_exposed" as const, severity: "info" as const, count: resources.definerFunctions },
      { key: "failed_sign_ins" as const, severity: "info" as const, count: insights.last24h.failedSignIns },
    ]
      .filter((item) => item.count > 0)
      // A severity decided by a number (the connections) keeps its place among its peers: errors first, the order above within each.
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    return {
      data: {
        instance: {
          version: TOTALBASE_VERSION,
          environment: context.nodeEnv,
          publicUrl,
          uptimeSeconds: Math.round(process.uptime()),
          lockdown: {
            active: lockdown.active,
            readOnly: lockdown.readOnly,
            endsAt: lockdown.endsAt === null ? null : new Date(lockdown.endsAt).toISOString(),
            startsAt: !lockdown.active && lockdown.window ? new Date(lockdown.window.from).toISOString() : null,
          },
        },
        kpis: {
          people,
          usableTokens,
          resources: { exposed: resources.exposed, total: resources.total },
          actions24h: { total: insights.last24h.actions, previous: insights.last24h.previousActions, denied: insights.last24h.denied, failed: insights.last24h.failed },
          sessionsActive,
          workflowRuns24h: runs24h,
        },
        services: [{ key: "smtp", state: smtpHost && smtpFrom ? "ON" : "NOT_CONFIGURED" }, ...switches],
        attention,
        activity: { timeZone: insights.timeZone, data: insights.dataPerDay, admin: insights.adminPerDay, problems: insights.problems },
        trends: { workflowRuns: runsPerDay },
        topResources: insights.topResources,
        system: {
          postgres,
          pool,
          backups: { enabled: backupsEnabled, lastCompletedAt: backups.lastCompletedAt, nextAt: backups.nextAt, recent: recentBackups },
          masterKey: context.masterKeyOrigin,
          outbox: { pending: outbox.pending, oldestPendingSeconds: outbox.oldestPendingSeconds },
          executions,
          maintenance: { running: maintenanceBatch !== null },
          space,
        },
      },
    };
  });
}
