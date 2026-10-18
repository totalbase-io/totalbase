import type { DatabaseTransactionContext, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/** A result column with its PostgreSQL type name (format_type), e.g. "timestamp with time zone". */
export interface ResultColumn {
  name: string;
  dataType: string;
}

/**
 * Names each result column's type from pg_type - the one lookup the SQL
 * Console, dashboard widgets and the table preview share. Never fails a
 * query that already ran: an unresolved type reads as `oid:<n>`.
 */
export async function resolveResultColumns(database: Queryable, fields: Array<{ name: string; dataTypeId: number }>): Promise<ResultColumn[]> {
  if (fields.length === 0) return [];
  try {
    const oids = [...new Set(fields.map((f) => f.dataTypeId))];
    const { rows } = await database.query<{ oid: number; name: string }>(
      `SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid = ANY($1)`,
      [oids],
    );
    const byOid = new Map(rows.map((r) => [r.oid, r.name]));
    return fields.map((f) => ({ name: f.name, dataType: byOid.get(f.dataTypeId) ?? `oid:${f.dataTypeId}` }));
  } catch {
    return fields.map((f) => ({ name: f.name, dataType: `oid:${f.dataTypeId}` }));
  }
}

export interface RelationRowsPage {
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  /** Another page follows. */
  hasMore: boolean;
  durationMs: number;
}

const MAX_PREVIEW_ROWS = 200;

/**
 * A page of a table's rows for the admin's read-only preview. The
 * relation is addressed by OID only - PostgreSQL turns it into the quoted
 * identifier (`oid::regclass`), the caller never supplies identifier text
 * - and read in its own READ ONLY transaction under `timeout`, so the
 * preview can't write or run away. Nothing is recorded: unlike the SQL
 * Console, looking at rows isn't a statement worth auditing.
 */
export async function previewRelationRows(
  database: { transaction<T>(fn: (client: Queryable) => Promise<T>, context?: DatabaseTransactionContext): Promise<T> },
  oid: number,
  page: { limit: number; offset: number },
  timeout: DatabaseTransactionContext,
): Promise<RelationRowsPage> {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_PREVIEW_ROWS) {
    throw new TotalBaseError("INVALID_QUERY", `limit must be between 1 and ${MAX_PREVIEW_ROWS}.`);
  }
  if (!Number.isInteger(page.offset) || page.offset < 0) throw new TotalBaseError("INVALID_QUERY", "offset must be 0 or more.");
  const startedAt = Date.now();
  return database.transaction(async (client) => {
    await client.query("SET TRANSACTION READ ONLY");
    const { rows: identRows } = await client.query<{ ident: string }>(
      `SELECT c.oid::regclass::text AS ident FROM pg_catalog.pg_class c WHERE c.oid = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
      [oid],
    );
    const ident = identRows[0]?.ident;
    if (!ident) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Table not found.");
    const result = await client.query(`SELECT * FROM ${ident} LIMIT $1 OFFSET $2`, [page.limit + 1, page.offset]);
    const columns = await resolveResultColumns(client, result.fields ?? []);
    return {
      columns,
      rows: result.rows.slice(0, page.limit),
      hasMore: result.rows.length > page.limit,
      durationMs: Date.now() - startedAt,
    };
  }, timeout);
}
