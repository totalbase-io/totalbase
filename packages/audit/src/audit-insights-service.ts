import { resolveDayZone, type Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/**
 * Aggregates over the audit log for the admin's Users → Insights pages
 * (Sign-ins, Activity) - every count computed by PostgreSQL, grouped in
 * the viewer's time zone (any name PostgreSQL accepts), never the
 * raw rows. Read-only; the log itself is written by AuditService.
 */

/** Sign-in attempts: the public API, the portal and OAuth (apps/server's ACCESS_EVENTS). */
export const SIGN_IN_EVENTS = ["auth.login", "auth.portal_login", "auth.oauth_login"] as const;

export const MAX_INSIGHTS_DAYS = 366;

/** The Logs page's action categories (useLogsFilters' LOGS_CATEGORIES), as SQL. */
const CATEGORY_SQL = `CASE
  WHEN action IN ('CREATE', 'UPDATE', 'DELETE', 'READ', 'EXECUTE') THEN 'data'
  WHEN action = 'AUTH' THEN 'access'
  WHEN action LIKE 'SQL\\_%' THEN 'sql'
  WHEN action IN ('IMPORT', 'EXPORT', 'PRINT') THEN 'bulk'
  ELSE 'other' END`;

export interface InsightsWindow {
  /** The last N days, today included (1 to MAX_INSIGHTS_DAYS). */
  days: number;
  /** IANA name the day / weekday / hour buckets are computed in. */
  timeZone: string;
  /**
   * The viewer's current UTC offset in minutes east (UTC-3 = -180) - used
   * when PostgreSQL doesn't know `timeZone` (a legacy alias like
   * America/Buenos_Aires, which browsers still report, is missing from
   * some tz databases).
   */
  utcOffsetMinutes?: number | undefined;
}

/** The zone the buckets were actually computed in - an IANA name, or a fixed offset like "UTC-03:00". */
interface ResolvedZone {
  /** SQL for the zone operand of AT TIME ZONE - always a bound parameter. */
  sql: string;
  value: string;
  label: string;
}

export interface SignInInsights {
  /** The zone the buckets were computed in (see InsightsWindow). */
  timeZone: string;
  totals: { succeeded: number; failed: number };
  /** One entry per day of the window, oldest first, zeros included. */
  perDay: Array<{ day: string; succeeded: number; failed: number }>;
  /** ISO weekday 1 (Monday) to 7 (Sunday) - successful sign-ins. */
  byWeekday: number[];
  /** Hour 0-23 - successful sign-ins. */
  byHour: number[];
  failuresByReason: Array<{ reason: string; count: number }>;
  topUsers: Array<{ user: string; count: number }>;
  /** Who failed most - an account (user id) when known, else the email tried. */
  topFailures: Array<{ user: string | null; email: string | null; count: number }>;
  recentFailures: Array<{ at: Date; email: string | null; user: string | null; reason: string | null; ip: string | null; event: string }>;
}

export interface ActivityInsights {
  timeZone: string;
  totals: { actions: number; writes: number; denied: number; failed: number };
  /** One entry per day of the window, oldest first, counts per category. */
  perDay: Array<{ day: string; data: number; access: number; sql: number; bulk: number; other: number }>;
  /** Data changes per day by kind - same days as perDay. */
  writesPerDay: Array<{ day: string; create: number; update: number; delete: number }>;
  /** [ISO weekday 1-7 - 1][hour 0-23] - every action. */
  heatmap: number[][];
  /** Where entries came from: admin, api, auth, workflow… */
  bySource: Array<{ source: string; count: number }>;
  /** Who acted most (principal type + id - an API_KEY is a token id; the caller maps it to its owner). Empty when scoped to principals. */
  topPrincipals: Array<{ principalType: string; principalId: string; count: number }>;
  /** Denied / failed entries grouped by error code (the status when there's none). */
  failures: Array<{ code: string; count: number; sample: string | null }>;
  /** Rows moved by Export / Import / Print, per resource (null: one deleted since - its entries keep counting) - the data-out watch. */
  dataOut: Array<{ resource: string | null; exported: number; imported: number; printed: number; operations: number }>;
  topResources: Array<{ resource: string; count: number }>;
  topActions: Array<{ action: string; count: number }>;
}

/** The admin dashboard's slice of the log (GET /admin/api/dashboard). */
export interface DashboardInsights {
  timeZone: string;
  /** One entry per day of the window, oldest first - the Logs page's categories. */
  perDay: ActivityInsights["perDay"];
  /** Denied and failed entries per day - same days as perDay. */
  problemsPerDay: Array<{ day: string; denied: number; failed: number }>;
  /** The rolling last 24 hours. */
  last24h: { actions: number; denied: number; failed: number; signIns: number; failedSignIns: number };
  /** The application's most used resources over the last 7 days - TotalBase's own tables left out. */
  topResources: Array<{ id: string; schema: string; name: string; type: string; count: number }>;
}

export class AuditInsightsService {
  constructor(private readonly database: Database) {}

  /**
   * The zone to group in: `timeZone` when PostgreSQL knows it (PostgreSQL
   * decides, by trying it), else the fixed `utcOffsetMinutes`, else an
   * error - an explicit but unknown zone never silently becomes UTC.
   */
  private async resolveWindow(window: InsightsWindow, param: number): Promise<ResolvedZone> {
    if (!Number.isInteger(window.days) || window.days < 1 || window.days > MAX_INSIGHTS_DAYS) {
      throw new TotalBaseError("INVALID_QUERY", `days must be between 1 and ${MAX_INSIGHTS_DAYS}.`);
    }
    const zone = await resolveDayZone(this.database, window.timeZone, window.utcOffsetMinutes);
    return { sql: `$${param}::${zone.cast}`, value: zone.value, label: zone.label };
  }

  async signIns(window: InsightsWindow): Promise<SignInInsights> {
    const zone = await this.resolveWindow(window, 3);
    // $1 events, $2 days, $3 time zone - shared by every query below.
    const params = [[...SIGN_IN_EVENTS], window.days, zone.value];
    const scope = `FROM totalbase.logs
      WHERE metadata->>'event' = ANY($1::text[])
        AND created_at >= date_trunc('day', now() AT TIME ZONE ${zone.sql}) AT TIME ZONE ${zone.sql} - make_interval(days => $2::int - 1)`;
    const ok = `status = 'EXECUTED'`;

    const [totals, perDay, weekday, hour, reasons, topUsers, topFailures, recent] = await Promise.all([
      this.database.query<{ succeeded: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE ${ok})::int AS succeeded, count(*) FILTER (WHERE NOT ${ok})::int AS failed ${scope}`,
        params,
      ),
      this.database.query<{ day: string; succeeded: number; failed: number }>(
        `WITH days AS (
           SELECT generate_series((now() AT TIME ZONE ${zone.sql})::date - ($2::int - 1), (now() AT TIME ZONE ${zone.sql})::date, interval '1 day')::date AS day
         ), counted AS (
           SELECT (created_at AT TIME ZONE ${zone.sql})::date AS day,
                  count(*) FILTER (WHERE ${ok})::int AS succeeded,
                  count(*) FILTER (WHERE NOT ${ok})::int AS failed
           ${scope}
           GROUP BY 1
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.succeeded, 0) AS succeeded, coalesce(c.failed, 0) AS failed
         FROM days d LEFT JOIN counted c USING (day) ORDER BY d.day`,
        params,
      ),
      this.database.query<{ bucket: number; count: number }>(
        `SELECT extract(isodow FROM created_at AT TIME ZONE ${zone.sql})::int AS bucket, count(*)::int AS count ${scope} AND ${ok} GROUP BY 1`,
        params,
      ),
      this.database.query<{ bucket: number; count: number }>(
        `SELECT extract(hour FROM created_at AT TIME ZONE ${zone.sql})::int AS bucket, count(*)::int AS count ${scope} AND ${ok} GROUP BY 1`,
        params,
      ),
      this.database.query<{ reason: string; count: number }>(
        `SELECT coalesce(metadata->>'reason', 'other') AS reason, count(*)::int AS count ${scope} AND NOT ${ok} GROUP BY 1 ORDER BY 2 DESC`,
        params,
      ),
      this.database.query<{ user: string; count: number }>(
        `SELECT principal AS "user", count(*)::int AS count ${scope} AND ${ok} AND principal IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        params,
      ),
      this.database.query<{ user: string | null; email: string | null; count: number }>(
        `SELECT metadata->>'user_id' AS "user", max(metadata->>'email') AS email, count(*)::int AS count
         ${scope} AND NOT ${ok}
         GROUP BY coalesce(metadata->>'user_id', lower(metadata->>'email')), metadata->>'user_id'
         ORDER BY 3 DESC LIMIT 5`,
        params,
      ),
      this.database.query<{ at: Date; email: string | null; user: string | null; reason: string | null; ip: string | null; event: string }>(
        `SELECT created_at AS at, metadata->>'email' AS email, metadata->>'user_id' AS "user",
                metadata->>'reason' AS reason, host(ip) AS ip, metadata->>'event' AS event
         ${scope} AND NOT ${ok} ORDER BY created_at DESC LIMIT 10`,
        params,
      ),
    ]);

    const buckets = (rows: Array<{ bucket: number; count: number }>, size: number, offset: number) => {
      const out = Array.from({ length: size }, () => 0);
      for (const row of rows) out[row.bucket - offset] = row.count;
      return out;
    };
    return {
      timeZone: zone.label,
      totals: totals.rows[0]!,
      perDay: perDay.rows,
      byWeekday: buckets(weekday.rows, 7, 1),
      byHour: buckets(hour.rows, 24, 0),
      failuresByReason: reasons.rows,
      topUsers: topUsers.rows,
      topFailures: topFailures.rows,
      recentFailures: recent.rows,
    };
  }

  /**
   * `principalIds`: one user's activity - their own id plus their API
   * tokens' ids (an entry made through a Data API token has the token as
   * its principal). Omitted: everyone's.
   */
  /**
   * What the dashboard shows of the log: activity per day and category in
   * the viewer's zone, denied and failed entries per day, the last 24 hours at a glance, the application's
   * busiest resources. Every query is bounded by created_at, so each
   * stays on logs_created_at_idx however long the log grows.
   */
  async dashboard(window: InsightsWindow): Promise<DashboardInsights> {
    const zone = await this.resolveWindow(window, 2);
    const params: unknown[] = [window.days, zone.value];
    const signIns = `metadata->>'event' = ANY($1::text[])`;
    const [perDay, problemsPerDay, last24h, topResources] = await Promise.all([
      this.database.query<DashboardInsights["perDay"][number]>(
        `WITH days AS (
           SELECT generate_series((now() AT TIME ZONE ${zone.sql})::date - ($1::int - 1), (now() AT TIME ZONE ${zone.sql})::date, interval '1 day')::date AS day
         ), counted AS (
           SELECT (created_at AT TIME ZONE ${zone.sql})::date AS day, ${CATEGORY_SQL} AS category, count(*)::int AS count
           FROM totalbase.logs
           WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${zone.sql}) AT TIME ZONE ${zone.sql} - make_interval(days => $1::int - 1)
           GROUP BY 1, 2
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'data'), 0)::int AS data,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'access'), 0)::int AS access,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'sql'), 0)::int AS sql,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'bulk'), 0)::int AS bulk,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'other'), 0)::int AS other
         FROM days d LEFT JOIN counted c USING (day)
         GROUP BY d.day ORDER BY d.day`,
        params,
      ),
      this.database.query<DashboardInsights["problemsPerDay"][number]>(
        `WITH days AS (
           SELECT generate_series((now() AT TIME ZONE ${zone.sql})::date - ($1::int - 1), (now() AT TIME ZONE ${zone.sql})::date, interval '1 day')::date AS day
         ), counted AS (
           SELECT (created_at AT TIME ZONE ${zone.sql})::date AS day,
                  count(*) FILTER (WHERE status = 'DENIED')::int AS denied,
                  count(*) FILTER (WHERE status = 'FAILED')::int AS failed
           FROM totalbase.logs
           WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${zone.sql}) AT TIME ZONE ${zone.sql} - make_interval(days => $1::int - 1)
             AND status IN ('DENIED', 'FAILED')
           GROUP BY 1
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.denied, 0) AS denied, coalesce(c.failed, 0) AS failed
         FROM days d LEFT JOIN counted c USING (day) ORDER BY d.day`,
        params,
      ),
      this.database.query<DashboardInsights["last24h"]>(
        `SELECT count(*)::int AS actions,
                count(*) FILTER (WHERE status = 'DENIED')::int AS denied,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                count(*) FILTER (WHERE ${signIns} AND status = 'EXECUTED')::int AS "signIns",
                count(*) FILTER (WHERE ${signIns} AND status <> 'EXECUTED')::int AS "failedSignIns"
         FROM totalbase.logs
         WHERE created_at >= now() - interval '24 hours'`,
        [[...SIGN_IN_EVENTS]],
      ),
      this.database.query<DashboardInsights["topResources"][number]>(
        `SELECT r.id, r."schema", r.name, r.type, count(*)::int AS count
         FROM totalbase.logs l
         JOIN totalbase.resources r ON r.id = l.resource
         WHERE l.created_at >= now() - interval '7 days' AND r."schema" <> 'totalbase'
         GROUP BY r.id, r."schema", r.name, r.type
         ORDER BY count(*) DESC, r."schema", r.name
         LIMIT 5`,
      ),
    ]);
    return { timeZone: zone.label, perDay: perDay.rows, problemsPerDay: problemsPerDay.rows, last24h: last24h.rows[0]!, topResources: topResources.rows };
  }

  async activity(window: InsightsWindow & { principalIds?: string[] | undefined }): Promise<ActivityInsights> {
    const zone = await this.resolveWindow(window, 2);
    const params: unknown[] = [window.days, zone.value];
    let principal = "";
    if (window.principalIds) {
      params.push(window.principalIds);
      principal = `AND principal = ANY($3::uuid[])`;
    }
    const scope = `FROM totalbase.logs
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${zone.sql}) AT TIME ZONE ${zone.sql} - make_interval(days => $1::int - 1) ${principal}`;

    const days = `WITH days AS (
           SELECT generate_series((now() AT TIME ZONE ${zone.sql})::date - ($1::int - 1), (now() AT TIME ZONE ${zone.sql})::date, interval '1 day')::date AS day
         )`;
    const rowCount = `CASE WHEN jsonb_typeof(metadata->'rowCount') = 'number' THEN (metadata->>'rowCount')::bigint ELSE 0 END`;

    const [totals, perDay, resources, actions, writes, heat, sources, principals, failures, dataOut] = await Promise.all([
      this.database.query<ActivityInsights["totals"]>(
        `SELECT count(*)::int AS actions,
                count(*) FILTER (WHERE action IN ('CREATE', 'UPDATE', 'DELETE'))::int AS writes,
                count(*) FILTER (WHERE status = 'DENIED')::int AS denied,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed
         ${scope}`,
        params,
      ),
      this.database.query<ActivityInsights["perDay"][number]>(
        `WITH days AS (
           SELECT generate_series((now() AT TIME ZONE ${zone.sql})::date - ($1::int - 1), (now() AT TIME ZONE ${zone.sql})::date, interval '1 day')::date AS day
         ), counted AS (
           SELECT (created_at AT TIME ZONE ${zone.sql})::date AS day, ${CATEGORY_SQL} AS category, count(*)::int AS count
           ${scope}
           GROUP BY 1, 2
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'data'), 0)::int AS data,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'access'), 0)::int AS access,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'sql'), 0)::int AS sql,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'bulk'), 0)::int AS bulk,
                coalesce(sum(c.count) FILTER (WHERE c.category = 'other'), 0)::int AS other
         FROM days d LEFT JOIN counted c USING (day)
         GROUP BY d.day ORDER BY d.day`,
        params,
      ),
      this.database.query<{ resource: string; count: number }>(
        `SELECT resource::text AS resource, count(*)::int AS count ${scope} AND resource IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        params,
      ),
      this.database.query<{ action: string; count: number }>(
        `SELECT coalesce(metadata->>'event', action) AS action, count(*)::int AS count ${scope}
         GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        params,
      ),
      this.database.query<ActivityInsights["writesPerDay"][number]>(
        `${days}, counted AS (
           SELECT (created_at AT TIME ZONE ${zone.sql})::date AS day, action, count(*)::int AS count
           ${scope} AND action IN ('CREATE', 'UPDATE', 'DELETE')
           GROUP BY 1, 2
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                coalesce(sum(c.count) FILTER (WHERE c.action = 'CREATE'), 0)::int AS "create",
                coalesce(sum(c.count) FILTER (WHERE c.action = 'UPDATE'), 0)::int AS "update",
                coalesce(sum(c.count) FILTER (WHERE c.action = 'DELETE'), 0)::int AS "delete"
         FROM days d LEFT JOIN counted c USING (day)
         GROUP BY d.day ORDER BY d.day`,
        params,
      ),
      this.database.query<{ weekday: number; hour: number; count: number }>(
        `SELECT extract(isodow FROM created_at AT TIME ZONE ${zone.sql})::int AS weekday,
                extract(hour FROM created_at AT TIME ZONE ${zone.sql})::int AS hour, count(*)::int AS count
         ${scope} GROUP BY 1, 2`,
        params,
      ),
      this.database.query<{ source: string; count: number }>(
        `SELECT source, count(*)::int AS count ${scope} GROUP BY 1 ORDER BY 2 DESC`,
        params,
      ),
      window.principalIds
        ? Promise.resolve({ rows: [] as ActivityInsights["topPrincipals"] })
        : this.database.query<ActivityInsights["topPrincipals"][number]>(
          `SELECT principal_type AS "principalType", principal::text AS "principalId", count(*)::int AS count
           ${scope} AND principal IS NOT NULL
           GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`,
          params,
        ),
      this.database.query<ActivityInsights["failures"][number]>(
        `SELECT coalesce(error_code, status) AS code, count(*)::int AS count, max(error_message) AS sample
         ${scope} AND status IN ('DENIED', 'FAILED')
         GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        params,
      ),
      this.database.query<ActivityInsights["dataOut"][number]>(
        `SELECT resource::text AS resource,
                coalesce(sum(${rowCount}) FILTER (WHERE action = 'EXPORT'), 0)::int AS exported,
                coalesce(sum(${rowCount}) FILTER (WHERE action = 'IMPORT'), 0)::int AS imported,
                coalesce(sum(${rowCount}) FILTER (WHERE action = 'PRINT'), 0)::int AS printed,
                count(*)::int AS operations
         ${scope} AND action IN ('EXPORT', 'IMPORT', 'PRINT')
         GROUP BY 1 ORDER BY sum(${rowCount}) DESC LIMIT 8`,
        params,
      ),
    ]);

    const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const cell of heat.rows) heatmap[cell.weekday - 1]![cell.hour] = cell.count;

    return {
      timeZone: zone.label,
      totals: totals.rows[0]!,
      perDay: perDay.rows,
      writesPerDay: writes.rows,
      heatmap,
      bySource: sources.rows,
      topPrincipals: principals.rows,
      failures: failures.rows,
      dataOut: dataOut.rows,
      topResources: resources.rows,
      topActions: actions.rows,
    };
  }
}
