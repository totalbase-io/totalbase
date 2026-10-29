import pg from "pg";
import { mapPostgresError, TotalBaseError, type PostgresDriverError } from "@totalbase/errors";
import type { DatabaseConfig } from "./config.js";
import type { DatabaseTransactionContext } from "./transaction-context.js";
import type { PostgresNotice } from "./notices.js";
import { listen, type ListenHandlers, type Subscription } from "./listener.js";
import { replicate, type ReplicationHandlers, type ReplicationOptions } from "./replication.js";

const { Pool } = pg;

/**
 * PostgreSQL's built-in `point` OID - node-postgres has no parser for it
 * out of the box (unlike its numeric/date/json builtins), so a `point`
 * column comes back as the raw text form ("(x,y)") without this. Scoped
 * to this Pool's own `types` config rather than mutating the global
 * `pg.types` registry, so it can't affect any other `pg` consumer in the
 * same process (e.g. a test file constructing its own Client).
 *
 * `{ lng, lat }` (x = longitude, y = latitude) - Postgres's own point(x,y)
 * has no inherent geographic meaning, so this fixes an explicit
 * convention matching GeoJSON's [lng, lat] order and PostGIS's own
 * ST_MakePoint(lng, lat) argument order (relevant if this column type
 * ever migrates to PostGIS's geography type later - the whole reason
 * `point` was chosen over jsonb/two-plain-columns in the first place).
 */
const POINT_OID = 600;
function parsePoint(raw: string): { lng: number; lat: number } | null {
  const match = /^\(([^,]+),([^,]+)\)$/.exec(raw);
  return match ? { lng: Number(match[1]), lat: Number(match[2]) } : null;
}
/**
 * `date` (a calendar day, no time and no zone) is returned as PostgreSQL's
 * own text, `YYYY-MM-DD`. node-postgres' default turns it into a JS Date at
 * local midnight of the *server's* timezone, which JSON then serializes as
 * a UTC instant (`1985-11-03T03:00:00.000Z` on a UTC-3 host) - a different
 * value on every server, and a day off for any client east of it.
 */
const DATE_OID = 1082;
const parseDate = (raw: string): string => raw;
/**
 * `interval` is returned as PostgreSQL's own text (`1 day 02:03:00`), and an
 * `interval[]` as an array of them. node-postgres' default is an object
 * (`{ days, hours }`) no form can show and no write takes back; the text is
 * what PostgreSQL accepts again as is.
 */
const INTERVAL_OID = 1186;
const INTERVAL_ARRAY_OID = 1187;
/** text[]'s parser (oid 1009, not among pg's TypeId names) - an array of the elements' text. */
const parseTextArray = pg.types.getTypeParser(1009 as Parameters<typeof pg.types.getTypeParser>[0], "text");
export type PoolClient = pg.PoolClient;

export interface ResultField {
  name: string;
  /** pg_type.oid of the column's PostgreSQL type - callers resolve to a readable name via format_type() if needed. */
  dataTypeId: number;
  /**
   * Where PostgreSQL says the column comes from (the row description): the table's oid and the column's attnum -
   * 0 for an expression (`sum(x)`, a cast, a literal). Through a subquery, its table's; from a view, the view's column.
   */
  tableId: number;
  columnId: number;
}

export interface QueryResult<Row extends pg.QueryResultRow = pg.QueryResultRow> {
  rows: Row[];
  rowCount: number;
  notices: PostgresNotice[];
  /** Column name/type metadata, e.g. for the SQL Console's result grid. */
  fields: ResultField[];
}

/** One statement of a raw multi-statement script (Database.queryRaw). */
export interface RawStatementResult {
  /** PostgreSQL's command tag: SELECT, INSERT, CREATE, ... */
  command: string;
  rows: pg.QueryResultRow[];
  rowCount: number;
  fields: ResultField[];
}

/** queryRaw's result: the last statement's, as QueryResult, and every statement's in order. */
export interface RawQueryResult<Row extends pg.QueryResultRow = pg.QueryResultRow> extends QueryResult<Row> {
  statements: RawStatementResult[];
}

/** A queryable handle, either the pool itself or a client bound to a transaction. */
export interface Queryable {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<Row>>;
}

/**
 * Owns the PostgreSQL connection pool and all raw `pg` access.
 * This is the only package allowed to import `pg` directly
 * (AGENTS.md section 6 / Foundations.md §18).
 */
/** The pool options DatabaseConfig's pool.* fields map to. */
export type PoolSettings = Pick<DatabaseConfig, "poolMax" | "poolIdleTimeoutMs" | "poolConnectionTimeoutMs" | "poolMaxLifetimeMs">;

export class Database implements Queryable {
  private pool: pg.Pool;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.pool = createPool(config);
  }

  /** The pool options in use right now - what a pool.* setting saved since only applies after a restart. */
  poolSettings(): PoolSettings {
    const { poolMax, poolIdleTimeoutMs, poolConnectionTimeoutMs, poolMaxLifetimeMs } = this.config;
    return { poolMax, poolIdleTimeoutMs, poolConnectionTimeoutMs, poolMaxLifetimeMs };
  }

  /** How the pool is doing right now - connections open, idle, and requests waiting for one (the admin dashboard's System card). */
  poolStats(): { max: number; total: number; idle: number; waiting: number } {
    return { max: this.config.poolMax, total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  /**
   * Replaces the pool with one built from `settings` (the pool.* settings,
   * read once the database is reachable), then drains the old one.
   * Meant for startup, before anything else holds a connection.
   */
  async reconfigurePool(settings: PoolSettings): Promise<boolean> {
    const next = { ...this.config, ...settings };
    const unchanged = (Object.keys(settings) as (keyof PoolSettings)[]).every((key) => next[key] === this.config[key]);
    if (unchanged) return false;
    const previous = this.pool;
    this.config = next;
    this.pool = createPool(next);
    await previous.end();
    return true;
  }

  private serverMajor: Promise<number> | undefined;

  /**
   * The PostgreSQL server's major version (15-18), read once and kept -
   * for version-gated SQL such as PostgreSQL 18's RETURNING OLD
   * (Foundations.md §6).
   */
  serverMajorVersion(): Promise<number> {
    this.serverMajor ??= this.query<{ server_version_num: string }>("SHOW server_version_num").then(
      ({ rows }) => Math.floor(Number.parseInt(rows[0]?.server_version_num ?? "0", 10) / 10000),
      (error: unknown) => {
        this.serverMajor = undefined; // not cached: the next call asks again
        throw error;
      },
    );
    return this.serverMajor;
  }

  /** Runs a single statement against the pool, outside any explicit context - under the pool's own statement_timeout (`createPool`). */
  async query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return runQuery<Row>(this.pool, sql, params, this.pool);
  }

  /**
   * Runs `sql` via PostgreSQL's SIMPLE query protocol - no bind
   * parameters at all, not even an empty array - which is the only way
   * to execute a multi-statement script (`stmt1; stmt2; ...`) in one
   * round trip. Every other method on this class forces `pg`'s extended
   * protocol (runQuery's `queryMode: "extended"` - an empty `values`
   * array alone would not), which structurally rejects stacked
   * statements; this method deliberately removes that
   * guardrail and MUST NEVER be called with anything but admin-typed
   * SQL Console input (Foundations.md §19: "SQL Console is
   * the explicit exception" to "No raw Data API SQL").
   */
  async queryRaw<Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string): Promise<RawQueryResult<Row>> {
    // `pg.Pool` doesn't emit 'notice' (only a checked-out client does) -
    // check one out explicitly so NOTICE/WARNING messages are never
    // silently dropped, same as transactionRaw() already does.
    const client = await this.pool.connect();
    try {
      return await runQueryRaw<Row>(client, sql, this.pool);
    } finally {
      client.release();
    }
  }

  /** Same escape hatch as queryRaw(), wrapped in BEGIN/COMMIT/ROLLBACK for the SQL Console's optional transaction mode. */
  async transactionRaw<T>(fn: (client: { queryRaw: (sql: string) => Promise<RawQueryResult> }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await runQueryRaw(client, "BEGIN", this.pool);
      const result = await fn({ queryRaw: (sql) => runQueryRaw(client, sql, this.pool) });
      await runQueryRaw(client, "COMMIT", this.pool);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        /* best-effort rollback; original error takes precedence */
      });
      throw await toTotalBaseError(error, this.pool);
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` inside a PostgreSQL transaction (BEGIN/COMMIT/ROLLBACK),
   * optionally applying a DatabaseTransactionContext as `SET LOCAL` GUCs.
   * See Foundations.md §18.
   */
  async transaction<T>(
    fn: (client: Queryable) => Promise<T>,
    context?: DatabaseTransactionContext,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await runQuery(client, "BEGIN", [], null);
      if (context) {
        await applyContext(client, context, this.config.statementTimeoutMs);
      }
      // A failing statement's constraint message is looked up after the ROLLBACK, on this same
      // connection (see runQuery's `lookup`) - never on a second one borrowed from the pool while
      // this one is held: with every connection inside a transaction, that borrow would wait on itself.
      const queryable: Queryable = {
        query: (sql, params = []) => runQuery(client, sql, params, null),
      };
      const result = await fn(queryable);
      if (context?.beforeCommit) await context.beforeCommit(queryable);
      await runQuery(client, "COMMIT", [], null);
      return result;
    } catch (error) {
      const rolledBack = await client.query("ROLLBACK").then(() => true, () => false);
      throw await toTotalBaseError(driverErrorOf(error) ?? error, rolledBack ? client : null);
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` in a READ ONLY transaction that always ends in ROLLBACK, for
   * SQL an author wrote (a dashboard widget's - AGENTS.md section 7). READ
   * ONLY refuses every write; the ROLLBACK undoes what READ ONLY allows and
   * would otherwise outlive the transaction on this pooled connection: a
   * session-level setting (`set_config('TimeZone', ..., false)`, SET
   * SESSION) - which a later request served by the same connection would
   * inherit. Nothing is committed: there is nothing to commit.
   */
  async readOnlyTransaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await runQuery(client, "BEGIN READ ONLY", [], null);
      return await fn({
        query: (sql, params = []) => runQuery(client, sql, params, null),
      });
    } finally {
      await client.query("ROLLBACK").catch(() => {
        /* best-effort: a failed rollback leaves the transaction aborted - pg resets it on the next BEGIN */
      });
      client.release();
    }
  }

  private readonly subscriptions = new Set<Subscription>();

  /** `LISTEN` on `channel` over a connection of its own (listener.ts); ended by `close()` too. */
  async listen(channel: string, handlers: ListenHandlers): Promise<Subscription> {
    const subscription = await listen(this.config, channel, handlers);
    const tracked: Subscription = {
      close: async () => {
        this.subscriptions.delete(tracked);
        await subscription.close();
      },
    };
    this.subscriptions.add(tracked);
    return tracked;
  }

  /** Logical replication of `options.publication` on a temporary slot of its own (replication.ts); ended by `close()` too. */
  async replicate(options: ReplicationOptions, handlers: ReplicationHandlers): Promise<Subscription> {
    const subscription = await replicate(this.config, options, handlers);
    const tracked: Subscription = {
      close: async () => {
        this.subscriptions.delete(tracked);
        await subscription.close();
      },
    };
    this.subscriptions.add(tracked);
    return tracked;
  }

  async close(): Promise<void> {
    await Promise.all([...this.subscriptions].map((subscription) => subscription.close()));
    await this.pool.end();
  }

  /** Used by /health/ready. Throws if PostgreSQL is unreachable. */
  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }
}

async function applyContext(
  client: pg.PoolClient,
  context: DatabaseTransactionContext,
  defaultStatementTimeoutMs: number,
): Promise<void> {
  // PostgreSQL's SET/SET LOCAL statements do not accept bind parameters.
  // set_config() is a regular function and does, so it is used instead of
  // string-concatenating untrusted values into SQL text. All of them in
  // one statement: one round trip per transaction, not up to seven.
  const settings: [string, string][] = [["statement_timeout", String(context.statementTimeoutMs ?? defaultStatementTimeoutMs)]];
  if (context.requestId) settings.push(["totalbase.request_id", context.requestId]);
  if (context.principal?.id) settings.push(["totalbase.user_id", context.principal.id]);
  if (context.actorUserId) settings.push(["totalbase.actor_user_id", context.actorUserId]);
  if (context.principal) settings.push(["totalbase.principal_type", context.principal.type]);
  if (context.timezone) settings.push(["TimeZone", context.timezone]);
  if (context.applicationName) settings.push(["application_name", context.applicationName]);
  await runQuery(
    client,
    `SELECT ${settings.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`).join(", ")}`,
    settings.flat(),
    null,
  );
}

function toResultField(field: pg.FieldDef): ResultField {
  return { name: field.name, dataTypeId: field.dataTypeID, tableId: field.tableID ?? 0, columnId: field.columnID ?? 0 };
}

async function runQuery<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  queryable: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[],
  lookup: pg.Pool | pg.PoolClient | null,
): Promise<QueryResult<Row>> {
  const notices: PostgresNotice[] = [];
  const onNotice = (notice: { severity?: string; message?: string; detail?: string; hint?: string; code?: string }) => {
    notices.push({
      severity: notice.severity ?? "NOTICE",
      message: notice.message ?? "",
      detail: notice.detail,
      hint: notice.hint,
      code: notice.code,
    });
  };

  // `pg.Pool` does not emit 'notice'; only checked-out clients/connections do.
  const emitter = queryable as unknown as { on?: (event: string, cb: typeof onNotice) => void; removeListener?: (event: string, cb: typeof onNotice) => void };
  emitter.on?.("notice", onNotice);

  try {
    // Always the extended protocol - even with no parameters, where `pg`
    // would otherwise fall back to the simple one - so PostgreSQL itself
    // rejects stacked statements (`SELECT 1; DELETE ...`) everywhere but
    // queryRaw()/transactionRaw().
    // `queryMode` is honored by pg >= 8.11 but missing from @types/pg.
    const config: pg.QueryConfig & { queryMode: "extended" } = { text: sql, values: params, queryMode: "extended" };
    const result = await queryable.query(config);
    const fields: ResultField[] = (result.fields ?? []).map(toResultField);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0, notices, fields };
  } catch (error) {
    throw await toTotalBaseError(error, lookup);
  } finally {
    emitter.removeListener?.("notice", onNotice);
  }
}

/** Same as runQuery(), except it never passes a `values` argument to `pg` at all - see Database.queryRaw(). */
async function runQueryRaw<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  queryable: pg.Pool | pg.PoolClient,
  sql: string,
  pool: pg.Pool,
): Promise<RawQueryResult<Row>> {
  const notices: PostgresNotice[] = [];
  const onNotice = (notice: { severity?: string; message?: string; detail?: string; hint?: string; code?: string }) => {
    notices.push({
      severity: notice.severity ?? "NOTICE",
      message: notice.message ?? "",
      detail: notice.detail,
      hint: notice.hint,
      code: notice.code,
    });
  };

  const emitter = queryable as unknown as { on?: (event: string, cb: typeof onNotice) => void; removeListener?: (event: string, cb: typeof onNotice) => void };
  emitter.on?.("notice", onNotice);

  try {
    const rawResult = (await queryable.query(sql)) as pg.QueryResult | pg.QueryResult[];
    // The simple query protocol (no `values` argument) returns an ARRAY
    // of results, one per `;`-separated statement, instead of a single
    // QueryResult - every one is kept; the top level is the last one,
    // matching how a SQL console conventionally shows the final output.
    const statements: RawStatementResult[] = (Array.isArray(rawResult) ? rawResult : [rawResult]).map((result) => ({
      command: result.command ?? "",
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? 0,
      fields: (result.fields ?? []).map(toResultField),
    }));
    const last = statements.at(-1);
    if (!last) {
      return { rows: [], rowCount: 0, notices, fields: [], statements };
    }
    return { rows: last.rows as Row[], rowCount: last.rowCount, notices, fields: last.fields, statements };
  } catch (error) {
    throw await toTotalBaseError(error, pool);
  } finally {
    emitter.removeListener?.("notice", onNotice);
  }
}

/** The driver's error a transaction's statement mapped without its constraint lookup (see toTotalBaseError). */
const DRIVER_ERROR = Symbol("totalbase.driverError");

function driverErrorOf(error: unknown): PostgresDriverError | undefined {
  return error instanceof TotalBaseError ? (error as unknown as { [DRIVER_ERROR]?: PostgresDriverError })[DRIVER_ERROR] : undefined;
}

/**
 * Maps a raw PostgreSQL driver error into a TotalBaseError, and - for a
 * CHECK constraint violation specifically - looks up whether that
 * constraint has its own COMMENT (see the Resources → a table →
 * Constraints "Error Message" field, packages/schema's
 * buildCommentOnConstraintSql) and substitutes it for Postgres's own
 * generic "violates check constraint ..." text when it does.
 *
 * Looks the comment up through `lookup`: the pool for a statement on its
 * own, or - inside a transaction, where the failing connection is unusable
 * until it is rolled back - `null`, which maps the error now and keeps the
 * driver's error on it (`driverErrorOf`) so `Database.transaction` enriches
 * it after the ROLLBACK on that same connection, never on a second one
 * borrowed while the first is held. A lookup failure (constraint gone,
 * pool exhausted, whatever) falls back to Postgres's own message rather
 * than masking the original error.
 */
async function toTotalBaseError(error: unknown, lookup: pg.Pool | pg.PoolClient | null): Promise<TotalBaseError> {
  if (error instanceof TotalBaseError) {
    return error;
  }
  const driverError: PostgresDriverError =
    error && typeof error === "object" && "message" in error ? (error as PostgresDriverError) : { message: String(error) };
  const mapped = mapPostgresError(driverError);
  if (!["CHECK_VIOLATION", "UNIQUE_VIOLATION", "FOREIGN_KEY_VIOLATION"].includes(mapped.code) || !driverError.constraint) {
    return mapped;
  }
  if (!lookup) {
    Object.defineProperty(mapped, DRIVER_ERROR, { value: driverError, enumerable: false });
    return mapped;
  }
  const found = await lookupConstraint(lookup, driverError.constraint, driverError.schema, driverError.table, driverError.dataType);
  const message = found.message;
  // A foreign key's column may be another table's (a delete refused): never a field of this row.
  const column = mapped.code === "FOREIGN_KEY_VIOLATION" ? null : found.column;
  if (!message && !column) {
    return mapped;
  }
  return new TotalBaseError(mapped.code, message ?? mapped.message, {
    source: "POSTGRESQL",
    detail: mapped.detail,
    hint: mapped.hint,
    position: mapped.position,
    sqlstate: mapped.sqlstate,
    constraint: mapped.constraint,
    field: column ?? undefined,
  });
}

/**
 * What a CHECK, UNIQUE or FOREIGN KEY violation reads, and which column it is about:
 * the message is the constraint's COMMENT when it carries one - or, for a
 * uniqueness enforced by a unique index rather than a constraint (e.g. on
 * lower(email)), the index's own COMMENT; the column, when the constraint
 * (or the index) covers exactly one, so a form shows it on that field. The
 * same for TotalBase's tables and the developer's. A domain's CHECK (the
 * error names the domain, no table) reads its own COMMENT ON CONSTRAINT ...
 * ON DOMAIN.
 */
async function lookupConstraint(
  pool: pg.Pool | pg.PoolClient,
  constraintName: string,
  schema: string | undefined,
  table: string | undefined,
  domain: string | undefined,
): Promise<{ message: string | null; column: string | null }> {
  if (domain && !table) {
    try {
      const { rows } = await pool.query<{ comment: string | null }>(
        `SELECT obj_description(c.oid, 'pg_constraint') AS comment
         FROM pg_constraint c
         JOIN pg_type t ON t.oid = c.contypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE c.conname = $1 AND t.typname = $3 AND ($2::text IS NULL OR n.nspname = $2)
         LIMIT 1`,
        [constraintName, schema ?? null, domain],
      );
      return { message: rows[0]?.comment ?? null, column: null };
    } catch {
      return { message: null, column: null };
    }
  }
  try {
    const { rows } = await pool.query<{ comment: string | null; column: string | null }>(
      `WITH con AS (
         SELECT c.oid, c.conrelid, c.conkey
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE c.conname = $1
           AND ($2::text IS NULL OR n.nspname = $2)
           AND ($3::text IS NULL OR t.relname = $3)
         LIMIT 1
       ), idx AS (
         SELECT i.oid, x.indrelid, x.indkey
         FROM pg_class i
         JOIN pg_index x ON x.indexrelid = i.oid
         JOIN pg_namespace n ON n.oid = i.relnamespace
         WHERE i.relname = $1 AND i.relkind = 'i'
           AND ($2::text IS NULL OR n.nspname = $2)
         LIMIT 1
       )
       SELECT
         coalesce((SELECT obj_description(oid, 'pg_constraint') FROM con), (SELECT obj_description(oid, 'pg_class') FROM idx)) AS comment,
         coalesce(
           (SELECT a.attname FROM con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1] WHERE cardinality(con.conkey) = 1),
           (SELECT a.attname FROM idx JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = idx.indkey[0]
            WHERE NOT EXISTS (SELECT 1 FROM con) AND array_length(idx.indkey::int2[], 1) = 1 AND idx.indkey[0] <> 0)
         ) AS column`,
      [constraintName, schema ?? null, table ?? null],
    );
    return { message: rows[0]?.comment ?? null, column: rows[0]?.column ?? null };
  } catch {
    return { message: null, column: null };
  }
}

function createPool(config: DatabaseConfig): pg.Pool {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // TLS to PostgreSQL (POSTGRES_SSL) - off by default; a managed PostgreSQL wants it.
    ssl: config.ssl,
    max: config.poolMax,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.poolConnectionTimeoutMs,
    maxLifetimeSeconds: Math.floor(config.poolMaxLifetimeMs / 1000),
    // The session's statement_timeout, sent in every connection's startup
    // packet - a ceiling for a statement run on the pool outside any
    // transaction (`query()`), which otherwise had none. A transaction's
    // own context (`applyContext`, SET LOCAL) still overrides it for its
    // duration; the session value is back once it ends.
    statement_timeout: config.statementTimeoutMs,
    types: {
      getTypeParser: (oid: number, format?: string) =>
        oid === POINT_OID ? parsePoint
          : oid === DATE_OID || oid === INTERVAL_OID ? parseDate
          : oid === INTERVAL_ARRAY_OID ? parseTextArray
          : pg.types.getTypeParser(oid, format as "text" | "binary" | undefined),
    },
  });

  // Surface pool-level connection errors instead of crashing the process.
  pool.on("error", (err) => {
     
    console.error("[@totalbase/database] idle client error", err);
  });
  return pool;
}
