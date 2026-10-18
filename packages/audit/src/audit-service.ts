import type { Queryable } from "@totalbase/database";
import type { SettingsService } from "@totalbase/settings";
import type { Principal } from "@totalbase/shared";

export type AuditAction = "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXECUTE" | "AUTH" | "SQL_EXECUTE" | "SQL_HISTORY_PURGE" | "IMPORT" | "EXPORT" | "PRINT" | "MAINTENANCE" | "DDL" | "AUDIT_PURGE";
export type AuditStatus = "DENIED" | "EXECUTED" | "FAILED";

export interface AuditErrorDetail {
  code?: string | undefined;
  sqlstate?: string | undefined;
  message?: string | undefined;
  detail?: string | undefined;
  hint?: string | undefined;
}

export interface AuditLogEntry {
  requestId: string;
  principal: Principal;
  session?: string | undefined;
  /** totalbase.resources.id; absent for AUTH events, which have no resource. */
  resourceId?: string | undefined;
  action: AuditAction;
  status: AuditStatus;
  source: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  fields?: unknown;
  whereClause?: unknown;
  payload?: unknown;
  changes?: unknown;
  metadata?: unknown;
  sqlText?: string | undefined;
  sqlParams?: unknown;
  error?: AuditErrorDetail | undefined;
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Writes totalbase.logs (Specification_Security.md §11.2).
 *
 * Mandatory invariant (Specification_Data_API.md §13.1): "business mutation + audit + outbox
 * event = same transaction" - callers pass the same `client` they used
 * for the mutation itself, never a separate connection.
 */
export class AuditService {
  constructor(private readonly settings: SettingsService) {}

  /** The new entry's id - null when the audit log is disabled (audit.enabled) and nothing was written. */
  async record(client: Queryable, entry: AuditLogEntry): Promise<string | null> {
    if (!(await this.settings.get("audit.enabled"))) return null;
    const [id] = await this.insertRows(client, [entry]);
    return id!;
  }

  /**
   * `record` for every row one operation wrote - a bulk CREATE's items, a
   * PATCH's matched rows, a transaction's operations - in ONE statement on
   * the caller's transaction client (Pre_Beta_Review 2.7: one round trip
   * per row held locks for the whole batch). Returns the entries' ids in
   * the order given; every id is null when the audit log is disabled.
   */
  async recordMany(client: Queryable, entries: AuditLogEntry[]): Promise<(string | null)[]> {
    if (entries.length === 0) return [];
    if (!(await this.settings.get("audit.enabled"))) return entries.map(() => null);
    return this.insertRows(client, entries);
  }

  /**
   * The entries, one `INSERT ... SELECT` over them as a jsonb array. Each
   * row's id is generated in the `input` CTE, so the ids come back in input
   * order by construction - not by trusting the order `RETURNING` happens to
   * emit (a CTE referenced twice is materialized once, so the volatile
   * gen_random_uuid() is evaluated one time per row).
   */
  private async insertRows(client: Queryable, entries: AuditLogEntry[]): Promise<string[]> {
    const storeSql = await this.settings.get("audit.store_sql");
    const storeSqlParams = await this.settings.get("audit.store_sql_params");
    const docs = entries.map((entry) => ({
      requestId: entry.requestId,
      principalType: entry.principal.type,
      principal: entry.principal.id,
      session: entry.session ?? null,
      resource: entry.resourceId ?? null,
      action: entry.action,
      status: entry.status,
      source: entry.source,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      // Each jsonb column travels as a JSON string and is parsed back on the
      // server, so an absent value (NULL column) and a document that is
      // itself `null` stay different, as they were with one parameter each.
      fields: entry.fields !== undefined ? JSON.stringify(entry.fields) : null,
      whereClause: entry.whereClause !== undefined ? JSON.stringify(entry.whereClause) : null,
      payload: entry.payload !== undefined ? JSON.stringify(entry.payload) : null,
      changes: entry.changes !== undefined ? JSON.stringify(entry.changes) : null,
      metadata: entry.metadata !== undefined ? JSON.stringify(entry.metadata) : null,
      sqlText: storeSql ? (entry.sqlText ?? null) : null,
      sqlParams: storeSql && storeSqlParams && entry.sqlParams !== undefined ? JSON.stringify(entry.sqlParams) : null,
      errorCode: entry.error?.code ?? null,
      sqlstate: entry.error?.sqlstate ?? null,
      errorMessage: entry.error?.message ?? null,
      errorDetail: entry.error?.detail ?? null,
      errorHint: entry.error?.hint ?? null,
      startedAt: entry.startedAt.toISOString(),
      finishedAt: entry.finishedAt.toISOString(),
      durationMs: entry.finishedAt.getTime() - entry.startedAt.getTime(),
    }));

    const { rows } = await client.query<{ id: string }>(
      `WITH input AS (
         SELECT gen_random_uuid() AS id, e.ord, e.doc
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(doc, ord)
       ), inserted AS (
         INSERT INTO totalbase.logs (
           id, request_id, principal_type, principal, session,
           resource, action, status, source,
           ip, user_agent,
           fields, where_clause, payload, changes, metadata,
           sql_text, sql_params,
           error_code, sqlstate, error_message, error_detail, error_hint,
           started_at, finished_at, duration_ms
         )
         SELECT id, (doc ->> 'requestId')::uuid, doc ->> 'principalType', (doc ->> 'principal')::uuid, (doc ->> 'session')::uuid,
                (doc ->> 'resource')::uuid, doc ->> 'action', doc ->> 'status', doc ->> 'source',
                (doc ->> 'ip')::inet, doc ->> 'userAgent',
                (doc ->> 'fields')::jsonb, (doc ->> 'whereClause')::jsonb, (doc ->> 'payload')::jsonb, (doc ->> 'changes')::jsonb, (doc ->> 'metadata')::jsonb,
                doc ->> 'sqlText', (doc ->> 'sqlParams')::jsonb,
                doc ->> 'errorCode', doc ->> 'sqlstate', doc ->> 'errorMessage', doc ->> 'errorDetail', doc ->> 'errorHint',
                (doc ->> 'startedAt')::timestamptz, (doc ->> 'finishedAt')::timestamptz, (doc ->> 'durationMs')::int
         FROM input
         ORDER BY ord
       )
       SELECT id FROM input ORDER BY ord`,
      [JSON.stringify(docs)],
    );
    return rows.map((row) => row.id);
  }
}
