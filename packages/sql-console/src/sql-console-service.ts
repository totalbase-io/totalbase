import { relationDetailCache, resolveResultColumns, type ResultColumn } from "@totalbase/pg-catalog";
import type { Database, PostgresNotice } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

export interface SqlExecuteInput {
  sql: string;
  /** Wraps the script in BEGIN/COMMIT/ROLLBACK (Administration.md §5.2: "optional transaction mode"). */
  transactional?: boolean | undefined;
  /** Rows returned at most (sql_console.max_rows) - the statement still runs in full. */
  maxRows?: number | undefined;
}

export type { ResultColumn };

/** One statement of the script, in order. */
export interface SqlStatementResult {
  /** PostgreSQL's command tag: SELECT, INSERT, CREATE, ... */
  command: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  columns: ResultColumn[];
}

/** A successful run - a failed one throws (PostgreSQL's error), after its history row is written. */
export interface SqlExecuteResult {
  status: "EXECUTED";
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when `rows` was cut to `maxRows` - `rowCount` is still the real total. */
  truncated: boolean;
  columns: ResultColumn[];
  /** Every statement of the script, in order - the top level repeats the last one. */
  statements: SqlStatementResult[];
  notices: PostgresNotice[];
  durationMs: number;
}

export interface SqlHistoryEntry {
  id: string;
  admin: string;
  sqlText: string;
  status: "EXECUTED" | "FAILED";
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

interface HistoryRow {
  id: string;
  admin: string;
  sql_text: string;
  status: "EXECUTED" | "FAILED";
  duration_ms: number | null;
  error_message: string | null;
  created_at: Date;
}

function toHistoryEntry(row: HistoryRow): SqlHistoryEntry {
  return {
    id: row.id,
    admin: row.admin,
    sqlText: row.sql_text,
    status: row.status,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

/**
 * Raw admin SQL execution (Administration.md §5). Deliberately
 * bypasses @totalbase/query-engine and the Permission Resolver
 * (Foundations.md §19: "SQL Console is the explicit exception") - it runs exactly what
 * the admin typed, as the configured PostgreSQL connection role.
 */
export class SqlConsoleService {
  constructor(private readonly database: Database) {}

  async execute(adminId: string, input: SqlExecuteInput): Promise<SqlExecuteResult> {
    const startedAt = Date.now();
    try {
      const result = input.transactional
        ? await this.database.transactionRaw((client) => client.queryRaw(input.sql))
        : await this.database.queryRaw(input.sql);
      const durationMs = Date.now() - startedAt;
      await this.recordHistory(adminId, input.sql, "EXECUTED", durationMs, undefined);
      const statements: SqlStatementResult[] = [];
      for (const statement of result.statements) {
        const rows = statement.rows as Record<string, unknown>[];
        const truncated = input.maxRows !== undefined && rows.length > input.maxRows;
        statements.push({
          command: statement.command,
          rows: truncated ? rows.slice(0, input.maxRows) : rows,
          rowCount: statement.rowCount,
          truncated,
          columns: await resolveResultColumns(this.database, statement.fields),
        });
      }
      const last = statements.at(-1) ?? { rows: [], rowCount: 0, truncated: false, columns: [] };
      return {
        status: "EXECUTED",
        rows: last.rows,
        rowCount: last.rowCount,
        truncated: last.truncated,
        columns: last.columns,
        statements,
        notices: result.notices,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof TotalBaseError ? error.message : String(error);
      await this.recordHistory(adminId, input.sql, "FAILED", durationMs, message);
      throw error;
    } finally {
      // The script may have been DDL (that is the console's point), and a
      // failed non-transactional script may still have run its first
      // statements: what getRelationDetail() cached may be stale either
      // way (relation-detail-cache.ts). Cleared here rather than by the
      // route so workflows' SQL steps, which run through this too, count.
      relationDetailCache.clear();
    }
  }

  /**
   * EXPLAIN without ANALYZE only plans the statement - it never executes
   * it. Over the extended protocol (query(), never queryRaw()), so a
   * stacked `SELECT 1; DELETE ...` is rejected by PostgreSQL instead of
   * running its trailing statement with no history or audit row.
   */
  async explain(sql: string): Promise<unknown> {
    const prefix = "EXPLAIN (FORMAT JSON) ";
    try {
      const result = await this.database.query(`${prefix}${sql}`);
      return (result.rows[0] as Record<string, unknown> | undefined)?.["QUERY PLAN"] ?? result.rows;
    } catch (error) {
      throw positionedIn(error, prefix.length);
    }
  }

  /** A page of the history, newest first, and how many entries match in all. */
  async listHistory(adminId?: string, limit = 50, offset = 0, search?: string): Promise<{ entries: SqlHistoryEntry[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (adminId) {
      params.push(adminId);
      conditions.push(`admin = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`sql_text ILIKE $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const filterParams = [...params];
    params.push(Math.min(limit, 500), offset);

    const [{ rows }, count] = await Promise.all([
      this.database.query<HistoryRow>(
        `SELECT * FROM totalbase.sql_queries ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      this.database.query<{ total: string }>(`SELECT count(*) AS total FROM totalbase.sql_queries ${where}`, filterParams),
    ]);
    return { entries: rows.map(toHistoryEntry), total: Number(count.rows[0]?.total ?? 0) };
  }

  /**
   * Deletes history entries older than `before`. Backs both the automatic
   * retention job (sql_console.history_retention_days) and the admin's
   * manual "purge before date" action - same operation, different caller.
   * Returns the number of rows removed.
   */
  async purgeHistory(before: Date): Promise<number> {
    const { rowCount } = await this.database.query(
      `DELETE FROM totalbase.sql_queries WHERE created_at < $1`,
      [before],
    );
    return rowCount;
  }

  async getHistoryEntry(id: string): Promise<SqlHistoryEntry> {
    const { rows } = await this.database.query<HistoryRow>(
      `SELECT * FROM totalbase.sql_queries WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new TotalBaseError("RESOURCE_NOT_FOUND", `SQL Console history entry not found: ${id}`);
    return toHistoryEntry(row);
  }

  /** Best-effort - a history-write failure must never mask the real execution outcome. */
  private async recordHistory(
    adminId: string,
    sqlText: string,
    status: "EXECUTED" | "FAILED",
    durationMs: number,
    errorMessage: string | undefined,
  ): Promise<void> {
    try {
      await this.database.query(
        `INSERT INTO totalbase.sql_queries (admin, sql_text, status, duration_ms, error_message)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, sqlText, status, durationMs, errorMessage ?? null],
      );
    } catch {
      // best-effort; never mask the original execution result/error
    }
  }
}

/**
 * PostgreSQL's error position counts from the start of the text it was
 * sent; shift it back by a prefix TotalBase added (EXPLAIN's) so it points
 * into what the administrator typed. A position inside the prefix is dropped.
 */
function positionedIn(error: unknown, prefixLength: number): unknown {
  if (!(error instanceof TotalBaseError) || error.position === undefined) return error;
  const position = error.position - prefixLength;
  return new TotalBaseError(error.code, error.message, {
    source: error.source,
    httpStatus: error.httpStatus,
    detail: error.detail,
    hint: error.hint,
    sqlstate: error.sqlstate,
    constraint: error.constraint,
    field: error.field,
    position: position > 0 ? position : undefined,
    cause: error,
  });
}
