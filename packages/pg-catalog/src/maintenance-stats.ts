import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/**
 * Read side of PostgreSQL maintenance (Administration.md §6):
 * sizes and vacuum/analyze state from PostgreSQL's own statistics views.
 * Every relation kind that VACUUM/ANALYZE/REINDEX apply to - ordinary and
 * partitioned tables, materialized views - in every schema but
 * PostgreSQL's own (TotalBase's own tables included: logs grow too).
 */

export interface MaintenanceTable {
  oid: number;
  schema: string;
  name: string;
  kind: "TABLE" | "PARTITIONED_TABLE" | "MATERIALIZED_VIEW";
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  toastBytes: number;
  /** pg_class.reltuples - the planner's estimate; -1 (never analyzed) is reported as null. */
  estimatedRows: number | null;
  liveRows: number | null;
  deadRows: number | null;
  lastVacuum: Date | null;
  lastAutovacuum: Date | null;
  lastAnalyze: Date | null;
  lastAutoanalyze: Date | null;
  owner: string;
  /** The configured role may VACUUM/ANALYZE/REINDEX it: owns it, or holds MAINTAIN (PostgreSQL 17+). */
  canMaintain: boolean;
  /** OIDs of its invalid indexes (a failed concurrent build) - unused by queries until rebuilt. */
  invalidIndexes: number[];
}

export interface MaintenanceIndex {
  oid: number;
  name: string;
  bytes: number;
  /** pg_stat_user_indexes.idx_scan - since the statistics were last reset. */
  scans: number;
  primary: boolean;
  unique: boolean;
  /** False after a failed REINDEX CONCURRENTLY / CREATE INDEX CONCURRENTLY - unused by queries until rebuilt or dropped. */
  valid: boolean;
  definition: string;
}

export interface MaintenanceOverview {
  database: string;
  version: string;
  sizeBytes: number;
  tables: MaintenanceTable[];
}

const KINDS: Record<string, MaintenanceTable["kind"]> = { r: "TABLE", p: "PARTITIONED_TABLE", m: "MATERIALIZED_VIEW" };

/**
 * MAINTAIN (and the pg_maintain role granting it) exist from PostgreSQL 17
 * only; before that, only the owner (or a member of the owner role -
 * superusers included) may run VACUUM/ANALYZE/REINDEX on a table.
 */
async function canMaintainExpression(database: Database): Promise<string> {
  const { rows } = await database.query<{ version: number }>(`SELECT current_setting('server_version_num')::int AS version`);
  return (rows[0]?.version ?? 0) >= 170000 ? `has_table_privilege(c.oid, 'MAINTAIN')` : `pg_has_role(c.relowner, 'MEMBER')`;
}

/** The database at a glance - the admin dashboard's System card. */
export interface DatabaseSummary {
  database: string;
  /** server_version, e.g. "17.2". */
  version: string;
  sizeBytes: number;
  /** Backends connected to this database right now, TotalBase's pool included (pg_stat_activity - the count needs no privilege). */
  connections: number;
  /** The server-wide max_connections. */
  maxConnections: number;
}

export async function getDatabaseSummary(database: Database): Promise<DatabaseSummary> {
  const { rows } = await database.query<{ database: string; version: string; size_bytes: string; connections: number; max_connections: number }>(
    `SELECT current_database() AS database, split_part(current_setting('server_version'), ' ', 1) AS version,
            pg_database_size(current_database()) AS size_bytes,
            (SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE datname = current_database()) AS connections,
            current_setting('max_connections')::int AS max_connections`,
  );
  const row = rows[0]!;
  return { database: row.database, version: row.version, sizeBytes: Number(row.size_bytes), connections: row.connections, maxConnections: row.max_connections };
}

/** What takes the database's space: tables and materialized views with their indexes and TOAST (`pg_total_relation_size`). */
export interface DatabaseSpace {
  /** Every schema but PostgreSQL's own, largest first. */
  schemas: Array<{ schema: string; bytes: number }>;
  /** TotalBase's own tables (the reserved `totalbase` schema), largest first. */
  totalbase: Array<{ table: string; bytes: number }>;
}

/** The dashboard's space breakdown - sizes from PostgreSQL itself, nothing stored. A partitioned table counts through its partitions. */
export async function getDatabaseSpace(database: Database): Promise<DatabaseSpace> {
  const { rows } = await database.query<{ schema: string; name: string; bytes: string }>(
    `SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid) AS bytes
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'`,
  );
  const bySchema = new Map<string, number>();
  const totalbase: DatabaseSpace["totalbase"] = [];
  for (const row of rows) {
    const bytes = Number(row.bytes);
    bySchema.set(row.schema, (bySchema.get(row.schema) ?? 0) + bytes);
    if (row.schema === "totalbase") totalbase.push({ table: row.name, bytes });
  }
  return {
    schemas: [...bySchema].map(([schema, bytes]) => ({ schema, bytes })).sort((a, b) => b.bytes - a.bytes || a.schema.localeCompare(b.schema)),
    totalbase: totalbase.sort((a, b) => b.bytes - a.bytes || a.table.localeCompare(b.table)),
  };
}

export async function getMaintenanceOverview(database: Database): Promise<MaintenanceOverview> {
  const canMaintain = await canMaintainExpression(database);
  const [{ rows: dbRows }, { rows }] = await Promise.all([
    database.query<{ database: string; version: string; size_bytes: string }>(
      `SELECT current_database() AS database, split_part(current_setting('server_version'), ' ', 1) AS version,
              pg_database_size(current_database()) AS size_bytes`,
    ),
    database.query<{
      oid: number;
      schema: string;
      name: string;
      relkind: string;
      total_bytes: string;
      table_bytes: string;
      index_bytes: string;
      toast_bytes: string;
      reltuples: number;
      n_live_tup: string | null;
      n_dead_tup: string | null;
      last_vacuum: Date | null;
      last_autovacuum: Date | null;
      last_analyze: Date | null;
      last_autoanalyze: Date | null;
      owner: string;
      can_maintain: boolean;
      invalid_indexes: number[];
    }>(
      `SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind,
              pg_total_relation_size(c.oid) AS total_bytes,
              -- pg_table_size: every fork (data, free space map,
              -- visibility map) plus TOAST - TOAST reported apart, so the
              -- three parts add up to the total exactly.
              pg_table_size(c.oid) - coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0) AS table_bytes,
              pg_indexes_size(c.oid) AS index_bytes,
              coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0) AS toast_bytes,
              c.reltuples,
              s.n_live_tup, s.n_dead_tup,
              s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze,
              pg_get_userbyid(c.relowner) AS owner,
              ${canMaintain} AS can_maintain,
              coalesce((SELECT array_agg(i.indexrelid::int) FROM pg_catalog.pg_index i
                        WHERE i.indrelid = c.oid AND NOT i.indisvalid), '{}') AS invalid_indexes
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid = c.oid
       WHERE c.relkind IN ('r', 'p', 'm')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\\_toast%'
         AND n.nspname NOT LIKE 'pg\\_temp%'
       ORDER BY pg_total_relation_size(c.oid) DESC, n.nspname, c.relname`,
    ),
  ]);
  const toNumber = (value: string | null) => (value === null ? null : Number(value));
  return {
    database: dbRows[0]!.database,
    version: dbRows[0]!.version,
    sizeBytes: Number(dbRows[0]!.size_bytes),
    tables: rows.map((row) => ({
      oid: row.oid,
      schema: row.schema,
      name: row.name,
      kind: KINDS[row.relkind]!,
      totalBytes: Number(row.total_bytes),
      tableBytes: Number(row.table_bytes),
      indexBytes: Number(row.index_bytes),
      toastBytes: Number(row.toast_bytes),
      estimatedRows: row.reltuples < 0 ? null : Math.round(row.reltuples),
      liveRows: toNumber(row.n_live_tup),
      deadRows: toNumber(row.n_dead_tup),
      lastVacuum: row.last_vacuum,
      lastAutovacuum: row.last_autovacuum,
      lastAnalyze: row.last_analyze,
      lastAutoanalyze: row.last_autoanalyze,
      owner: row.owner,
      canMaintain: row.can_maintain,
      invalidIndexes: row.invalid_indexes,
    })),
  };
}

/** The indexes of one table/materialized view (by its OID), largest first. Empty for an unknown OID. */
/** A table's indexes, largest first. The table must be one the maintenance screen lists - RESOURCE_NOT_FOUND otherwise. */
export async function listMaintenanceIndexes(database: Database, tableOid: number): Promise<MaintenanceIndex[]> {
  const { rows } = await database.query<{
    oid: number | null;
    name: string;
    bytes: string;
    scans: string | null;
    primary: boolean;
    unique: boolean;
    valid: boolean;
    definition: string;
  }>(
    `SELECT i.indexrelid AS oid, ic.relname AS name, pg_relation_size(i.indexrelid) AS bytes,
            s.idx_scan AS scans, i.indisprimary AS primary, i.indisunique AS unique, i.indisvalid AS valid,
            pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_catalog.pg_index i ON i.indrelid = c.oid
     LEFT JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
     LEFT JOIN pg_catalog.pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
     WHERE c.oid = $1 AND c.relkind IN ('r', 'p', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY pg_relation_size(i.indexrelid) DESC, ic.relname`,
    [tableOid],
  );
  if (rows.length === 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Table not found: OID ${tableOid}`);
  return rows.filter((row) => row.oid !== null).map((row) => ({
    oid: row.oid!,
    name: row.name,
    bytes: Number(row.bytes),
    scans: Number(row.scans ?? 0),
    primary: row.primary,
    unique: row.unique,
    valid: row.valid,
    definition: row.definition,
  }));
}

/** What a maintenance action runs against, resolved from trusted catalog metadata by OID. */
export interface MaintenanceTarget {
  tableOid: number;
  schema: string;
  table: string;
  kind: MaintenanceTable["kind"];
  owner: string;
  /** Checked again right before running: PostgreSQL answers a VACUUM it may not run with a WARNING and does nothing. */
  canMaintain: boolean;
  /** Set when the action targets one index (REINDEX INDEX) - an index of `tableOid`. */
  index?: { oid: number; name: string } | undefined;
}

/**
 * Resolves a table (and optionally one of its indexes) by OID. Null when
 * the OID isn't a table/partitioned table/materialized view outside
 * PostgreSQL's own schemas, or the index doesn't belong to it.
 */
export async function resolveMaintenanceTarget(database: Database, tableOid: number, indexOid?: number): Promise<MaintenanceTarget | null> {
  const canMaintain = await canMaintainExpression(database);
  const { rows } = await database.query<{ schema: string; name: string; relkind: string; owner: string; can_maintain: boolean }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind, pg_get_userbyid(c.relowner) AS owner, ${canMaintain} AS can_maintain
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = $1 AND c.relkind IN ('r', 'p', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`,
    [tableOid],
  );
  const row = rows[0];
  if (!row) return null;
  const target: MaintenanceTarget = {
    tableOid,
    schema: row.schema,
    table: row.name,
    kind: KINDS[row.relkind]!,
    owner: row.owner,
    canMaintain: row.can_maintain,
  };
  if (indexOid === undefined) return target;
  const { rows: indexRows } = await database.query<{ name: string }>(
    `SELECT ic.relname AS name FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indexrelid = $1 AND i.indrelid = $2`,
    [indexOid, tableOid],
  );
  return indexRows[0] ? { ...target, index: { oid: indexOid, name: indexRows[0].name } } : null;
}
