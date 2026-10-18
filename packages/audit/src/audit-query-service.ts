import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

export interface AuditLogEntryRow {
  id: string;
  requestId: string;
  principalType: string;
  principalId: string | null;
  session: string | null;
  resource: string | null;
  action: string;
  status: string;
  source: string;
  ip: string | null;
  userAgent: string | null;
  fields: unknown;
  whereClause: unknown;
  payload: unknown;
  changes: unknown;
  metadata: unknown;
  sqlText: string | null;
  sqlParams: unknown;
  errorCode: string | null;
  sqlstate: string | null;
  errorMessage: string | null;
  errorDetail: string | null;
  errorHint: string | null;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  createdAt: Date;
}

export interface AuditLogFilter {
  resourceId?: string | undefined;
  principalType?: string | undefined;
  principalId?: string | undefined;
  /** One action, or several (a category - "Data changes" is CREATE/UPDATE/DELETE/EXECUTE). */
  action?: string | string[] | undefined;
  /** One status, or several. */
  status?: string | string[] | undefined;
  /** Every entry written by one HTTP request (a nested write can record several). */
  requestId?: string | undefined;
  /**
   * One row's own history (the admin's RecordFormActions "View history") -
   * `payload` always carries the row's primary key regardless of action
   * (mutation-service.ts sets `payload: newRow ?? oldRow ?? {}`, the
   * RESULTING/existing row, not just what the client submitted - so even
   * a server-generated id on CREATE shows up here). Both required
   * together; `resourceId` should also be set so this doesn't scan every
   * table's audit log for a column name that happens to match.
   */
  payloadPkColumn?: string | undefined;
  payloadPkValue?: string | undefined;
  /**
   * Access event names (metadata.event, e.g. "user.roles_set"). An entry
   * ending in ".*" matches by prefix ("permission.*" is every
   * permission.set / permission.clear) - how the admin's security views
   * ask for "every role and permission change" in one filter.
   */
  event?: string | string[] | undefined;
  /**
   * Access history of one role: entries whose role changes added or
   * removed it (metadata.roles_added / roles_removed) - the Members tab's
   * access review.
   */
  roleChange?: string | undefined;
  /** Every entry written by one workflow run's steps (`workflow_run`, from metadata.workflowRun - Specification_Workflows.md §7.4). */
  workflowRun?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  /**
   * Strictly `created_at < value` - unlike `until` (`<=`), which two
   * entries could share down to the millisecond. Used to look up ONE
   * record's own nearest-earlier entry (RecordHistoryPanel.vue's own
   * on-demand diff lookup, needed once its own history got paginated -
   * "the entry right before THIS one", not "on or before this instant",
   * which could echo the very entry being diffed back at itself.
   */
  strictlyBefore?: Date | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function toEntry(row: Record<string, unknown>): AuditLogEntryRow {
  return {
    id: row["id"] as string,
    requestId: row["request_id"] as string,
    principalType: row["principal_type"] as string,
    principalId: row["principal"] as string | null,
    session: row["session"] as string | null,
    resource: row["resource"] as string | null,
    action: row["action"] as string,
    status: row["status"] as string,
    source: row["source"] as string,
    ip: row["ip"] as string | null,
    userAgent: row["user_agent"] as string | null,
    fields: row["fields"],
    whereClause: row["where_clause"],
    payload: row["payload"],
    changes: row["changes"],
    metadata: row["metadata"],
    sqlText: row["sql_text"] as string | null,
    sqlParams: row["sql_params"],
    errorCode: row["error_code"] as string | null,
    sqlstate: row["sqlstate"] as string | null,
    errorMessage: row["error_message"] as string | null,
    errorDetail: row["error_detail"] as string | null,
    errorHint: row["error_hint"] as string | null,
    startedAt: row["started_at"] as Date,
    finishedAt: row["finished_at"] as Date,
    durationMs: row["duration_ms"] as number,
    createdAt: row["created_at"] as Date,
  };
}

/** Past this many matching entries, list() reports "10 000+" instead of an exact total. */
export const AUDIT_COUNT_CAP = 10_000;

export interface AuditLogSummary {
  byStatus: Record<string, number>;
  byPrincipalType: Record<string, number>;
  byAction: Record<string, number>;
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== "");
}

/** `%`, `_` and `\` are LIKE wildcards/escape - a prefix matches literally. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The WHERE clause shared by list() and summary(). Every value is a bind
 * parameter - column names are the fixed ones below, never caller input.
 */
function buildWhere(filter: AuditLogFilter): { whereSql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const oneOrAny = (column: string, value: string | string[] | undefined) => {
    const values = asList(value);
    if (values.length === 1) conditions.push(`${column} = ${bind(values[0])}`);
    else if (values.length > 1) conditions.push(`${column} = ANY(${bind(values)})`);
  };

  if (filter.resourceId) conditions.push(`resource = ${bind(filter.resourceId)}`);
  if (filter.principalType) conditions.push(`principal_type = ${bind(filter.principalType)}`);
  if (filter.principalId) conditions.push(`principal = ${bind(filter.principalId)}`);
  oneOrAny("action", filter.action);
  oneOrAny("status", filter.status);
  if (filter.requestId) conditions.push(`request_id = ${bind(filter.requestId)}`);
  if (filter.payloadPkColumn && filter.payloadPkValue) {
    // A bind parameter for the JSON key too - JSONB's ->> accepts any text
    // expression on the right, so the column name is never interpolated.
    conditions.push(`payload ->> ${bind(filter.payloadPkColumn)} = ${bind(filter.payloadPkValue)}`);
  }
  const events = asList(filter.event);
  if (events.length > 0) {
    const exact = events.filter((e) => !e.endsWith(".*"));
    const prefixes = events.filter((e) => e.endsWith(".*")).map((e) => likePrefix(e.slice(0, -1)));
    const parts: string[] = [];
    // `event` is metadata ->> 'event' as an indexed generated column.
    if (exact.length > 0) parts.push(`event = ANY(${bind(exact)})`);
    if (prefixes.length > 0) parts.push(`event LIKE ANY(${bind(prefixes)})`);
    conditions.push(parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`);
  }
  if (filter.roleChange) {
    const added = bind(JSON.stringify({ roles_added: [filter.roleChange] }));
    const removed = bind(JSON.stringify({ roles_removed: [filter.roleChange] }));
    // A role's members also change through the Data API (delegated users,
    // Specification_Security.md §9.4): an assignment row written or
    // deleted, its event named by the mutation's audit entry.
    const role = bind(filter.roleChange);
    conditions.push(
      `(metadata @> ${added}::jsonb OR metadata @> ${removed}::jsonb
        OR (event IN ('assignment.create', 'assignment.delete') AND payload ->> 'role' = ${role}))`,
    );
  }
  // `workflow_run` is metadata ->> 'workflowRun' as an indexed generated column.
  if (filter.workflowRun) conditions.push(`workflow_run = ${bind(filter.workflowRun)}`);
  if (filter.since) conditions.push(`created_at >= ${bind(filter.since)}`);
  if (filter.until) conditions.push(`created_at <= ${bind(filter.until)}`);
  if (filter.strictlyBefore) conditions.push(`created_at < ${bind(filter.strictlyBefore)}`);

  return { whereSql: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "", params };
}

/**
 * Read side of totalbase.logs for the Admin API (Specification_Security.md §11.8:
 * "GET /audit/activity", "GET /audit/logs",
 * "GET /audit/logs/{id}", "GET /resources/{resource}/audit").
 */
export class AuditQueryService {
  constructor(private readonly database: Database) {}

  async list(filter: AuditLogFilter = {}): Promise<{ data: AuditLogEntryRow[]; total: number; totalCapped: boolean }> {
    const { whereSql, params } = buildWhere(filter);
    const limit = Math.min(filter.limit ?? 50, 500);
    const offset = filter.offset ?? 0;

    // Counted up to AUDIT_COUNT_CAP + 1 rows, never the whole filtered log:
    // an unbounded count(*) re-reads every matching row on each page, and
    // past ten thousand entries the exact figure tells an operator nothing
    // a narrower filter wouldn't tell them better.
    const { rows: countRows } = await this.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (SELECT 1 FROM totalbase.logs${whereSql} LIMIT ${AUDIT_COUNT_CAP + 1}) capped`,
      params,
    );
    const counted = countRows[0]?.count ?? 0;

    const pageParams = [...params, limit, offset];
    const { rows } = await this.database.query(
      `SELECT * FROM totalbase.logs${whereSql} ORDER BY created_at DESC LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );

    return {
      data: rows.map((row) => toEntry(row as Record<string, unknown>)),
      total: Math.min(counted, AUDIT_COUNT_CAP),
      totalCapped: counted > AUDIT_COUNT_CAP,
    };
  }

  /**
   * Faceted counts for the admin's Logs panel: how many entries each
   * status / principal type / action has under the current filters. Each
   * facet ignores its OWN filter (choosing "Denied" still shows how many
   * Executed and Failed there are to switch to) but honors every other one.
   *
   * Exact counts (not capped like list()'s total): a facet's number is what
   * the panel shows beside each option, and three facets capped separately
   * would disagree with each other. Retention bounds the table.
   */
  async summary(filter: AuditLogFilter = {}): Promise<AuditLogSummary> {
    const facet = async (column: "status" | "principal_type" | "action", without: Partial<AuditLogFilter>) => {
      const { whereSql, params } = buildWhere({ ...filter, ...without });
      const { rows } = await this.database.query<{ key: string; count: number }>(
        `SELECT ${column} AS key, count(*)::int AS count FROM totalbase.logs${whereSql} GROUP BY ${column}`,
        params,
      );
      return Object.fromEntries(rows.map((row) => [row.key, row.count]));
    };
    const [byStatus, byPrincipalType, byAction] = await Promise.all([
      facet("status", { status: undefined }),
      facet("principal_type", { principalType: undefined }),
      facet("action", { action: undefined }),
    ]);
    return { byStatus, byPrincipalType, byAction };
  }

  async get(id: string): Promise<AuditLogEntryRow> {
    const { rows } = await this.database.query(`SELECT * FROM totalbase.logs WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Audit log entry not found: ${id}`);
    return toEntry(row as Record<string, unknown>);
  }

  /** Recent activity feed - same data as list(), just a small default page for a dashboard/activity view. */
  async recentActivity(limit = 20): Promise<AuditLogEntryRow[]> {
    const { data } = await this.list({ limit });
    return data;
  }
}
