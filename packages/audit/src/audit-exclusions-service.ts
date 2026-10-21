import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/** The writes the audit log records with their row (Security.md §11.3). */
export type AuditWriteAction = "CREATE" | "UPDATE" | "DELETE";

/**
 * totalbase.audits_exclusions (Security.md §11.4):
 * every write is audited whole by default; these are the columns of a
 * resource an administrator keeps out of the log - its `payload` and
 * `changes`, for every action. Stored by attnum (a rename keeps the
 * exclusion), read and written by column name - PostgreSQL's catalog maps
 * one to the other through the resource's OID.
 */
export class AuditExclusionsService {
  constructor(private readonly database: Queryable) {}

  /** The excluded columns' current names, in column order (a dropped one is gone). `on`: the transaction's own client, when read inside one. */
  async list(resourceId: string, on: Queryable = this.database): Promise<string[]> {
    const { rows } = await on.query<{ name: string }>(
      `SELECT a.attname::text AS name
       FROM totalbase.audits_exclusions e
       JOIN totalbase.resources r ON r.id = e.resource
       JOIN pg_catalog.pg_attribute a ON a.attrelid = r.postgres_oid AND a.attnum = e.column_attnum AND NOT a.attisdropped
       WHERE e.resource = $1
       ORDER BY a.attnum`,
      [resourceId],
    );
    return rows.map((row) => row.name);
  }

  /** The same, as a set for the write path's membership checks. */
  async excludedFields(resourceId: string, on?: Queryable): Promise<Set<string>> {
    return new Set(await this.list(resourceId, on));
  }

  /**
   * Replaces the whole list in one statement - PostgreSQL applies it whole or
   * not at all. Every name must be a column of the resource
   * (INVALID_QUERY otherwise); repeated names collapse; [] clears it.
   */
  async set(resourceId: string, fields: string[]): Promise<void> {
    const { rows } = await this.database.query<{ unknown: string[] }>(
      `WITH wanted AS (
         SELECT DISTINCT f AS name FROM unnest($2::text[]) AS f
       ), resolved AS (
         SELECT w.name, a.attnum
         FROM wanted w
         LEFT JOIN totalbase.resources r ON r.id = $1
         LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = r.postgres_oid AND a.attname = w.name AND a.attnum > 0 AND NOT a.attisdropped
       ), cleared AS (
         DELETE FROM totalbase.audits_exclusions
         WHERE resource = $1 AND NOT EXISTS (SELECT 1 FROM resolved WHERE resolved.attnum IS NULL)
           AND column_attnum <> ALL (SELECT attnum FROM resolved WHERE attnum IS NOT NULL)
       ), inserted AS (
         INSERT INTO totalbase.audits_exclusions (resource, column_attnum)
         SELECT $1, attnum FROM resolved
         WHERE attnum IS NOT NULL AND NOT EXISTS (SELECT 1 FROM resolved WHERE resolved.attnum IS NULL)
         ON CONFLICT (resource, column_attnum) DO NOTHING
       )
       SELECT coalesce(array_agg(name ORDER BY name) FILTER (WHERE attnum IS NULL), '{}') AS unknown FROM resolved`,
      [resourceId, fields],
    );
    const unknown = rows[0]?.unknown ?? [];
    if (unknown.length > 0) {
      throw new TotalBaseError("INVALID_QUERY", `Not a column of this resource: ${unknown.join(", ")}`);
    }
  }
}

/** A row without the excluded columns - what the audit log keeps of it. */
export function withoutExcludedFields(
  row: Record<string, unknown> | undefined,
  excluded: Set<string>,
): Record<string, unknown> | undefined {
  if (!row || excluded.size === 0) return row;
  return Object.fromEntries(Object.entries(row).filter(([field]) => !excluded.has(field)));
}

/**
 * An UPDATE's `changes` (Security.md §11.4): `{ column: { old,
 * new } }` for every column the update changed, the excluded ones left out.
 * undefined when the old row isn't known (a table without a primary key on
 * PostgreSQL 15-17 - the entry keeps the resulting row) or nothing changed.
 */
export function buildUpdateChanges(
  oldRow: Record<string, unknown> | undefined,
  newRow: Record<string, unknown> | undefined,
  excluded: Set<string>,
): Record<string, { old: unknown; new: unknown }> | undefined {
  if (!oldRow || !newRow) return undefined;
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const field of Object.keys(newRow)) {
    if (excluded.has(field) || !(field in oldRow)) continue;
    if (JSON.stringify(oldRow[field]) !== JSON.stringify(newRow[field])) {
      changes[field] = { old: oldRow[field], new: newRow[field] };
    }
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}
