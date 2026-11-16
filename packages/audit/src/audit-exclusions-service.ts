import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/** The writes the audit log records with their row (Security.md §11.3). */
export type AuditWriteAction = "CREATE" | "UPDATE" | "DELETE";

/** A resource's exclusions, for the write path's membership checks. */
export interface Exclusions {
  /** Columns kept out of the audit log - `payload`, and their values in `changes`. */
  audit: Set<string>;
  /** Those of them also kept out of the outbox event. */
  event: Set<string>;
}

/**
 * totalbase.audits_exclusions (Security.md §11.4):
 * every write is audited whole by default; these are the columns of a
 * resource an administrator keeps out of the log - its `payload` and
 * `changes`, for every action - and, for the ones marked `event`, out of
 * the outbox event too. Stored by attnum (a rename keeps the
 * exclusion), read and written by column name - PostgreSQL's catalog maps
 * one to the other through the resource's OID.
 */
export class AuditExclusionsService {
  constructor(private readonly database: Queryable) {}

  private async rows(resourceId: string, on: Queryable): Promise<{ name: string; event: boolean }[]> {
    const { rows } = await on.query<{ name: string; event: boolean }>(
      `SELECT a.attname::text AS name, e.event
       FROM totalbase.audits_exclusions e
       JOIN totalbase.resources r ON r.id = e.resource
       JOIN pg_catalog.pg_attribute a ON a.attrelid = r.postgres_oid AND a.attnum = e.column_attnum AND NOT a.attisdropped
       WHERE e.resource = $1
       ORDER BY a.attnum`,
      [resourceId],
    );
    return rows;
  }

  /** The excluded columns' current names, in column order (a dropped one is gone). `on`: the transaction's own client, when read inside one. */
  async list(resourceId: string, on: Queryable = this.database): Promise<string[]> {
    return (await this.rows(resourceId, on)).map((row) => row.name);
  }

  /** Both lists by name, in column order - what the Admin API answers. */
  async describe(resourceId: string, on: Queryable = this.database): Promise<{ excludedFields: string[]; eventExcludedFields: string[] }> {
    const rows = await this.rows(resourceId, on);
    return { excludedFields: rows.map((row) => row.name), eventExcludedFields: rows.filter((row) => row.event).map((row) => row.name) };
  }

  /** The audit exclusions as a set. */
  async excludedFields(resourceId: string, on?: Queryable): Promise<Set<string>> {
    return new Set(await this.list(resourceId, on));
  }

  /** Both sets, in one read - the write path's. */
  async exclusions(resourceId: string, on: Queryable = this.database): Promise<Exclusions> {
    const rows = await this.rows(resourceId, on);
    return { audit: new Set(rows.map((row) => row.name)), event: new Set(rows.filter((row) => row.event).map((row) => row.name)) };
  }

  /**
   * Replaces the whole list in one statement - PostgreSQL applies it whole or
   * not at all. Every name must be a column of the resource
   * (INVALID_QUERY otherwise); repeated names collapse; [] clears it.
   * `eventFields`: the ones also kept out of the outbox event - each must be
   * in `fields` (an event exclusion is an audit exclusion first).
   */
  async set(resourceId: string, fields: string[], eventFields: string[] = []): Promise<void> {
    const outside = eventFields.filter((field) => !fields.includes(field));
    if (outside.length > 0) {
      throw new TotalBaseError("INVALID_QUERY", `Excluded from events but not from the audit log: ${[...new Set(outside)].sort().join(", ")}`);
    }
    const { rows } = await this.database.query<{ unknown: string[] }>(
      `WITH wanted AS (
         SELECT DISTINCT f AS name, f = ANY ($3::text[]) AS event FROM unnest($2::text[]) AS f
       ), resolved AS (
         SELECT w.name, w.event, a.attnum
         FROM wanted w
         LEFT JOIN totalbase.resources r ON r.id = $1
         LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = r.postgres_oid AND a.attname = w.name AND a.attnum > 0 AND NOT a.attisdropped
       ), cleared AS (
         DELETE FROM totalbase.audits_exclusions
         WHERE resource = $1 AND NOT EXISTS (SELECT 1 FROM resolved WHERE resolved.attnum IS NULL)
           AND column_attnum <> ALL (SELECT attnum FROM resolved WHERE attnum IS NOT NULL)
       ), inserted AS (
         INSERT INTO totalbase.audits_exclusions (resource, column_attnum, event)
         SELECT $1, attnum, event FROM resolved
         WHERE attnum IS NOT NULL AND NOT EXISTS (SELECT 1 FROM resolved WHERE resolved.attnum IS NULL)
         ON CONFLICT (resource, column_attnum) DO UPDATE SET event = EXCLUDED.event
       )
       SELECT coalesce(array_agg(name ORDER BY name) FILTER (WHERE attnum IS NULL), '{}') AS unknown FROM resolved`,
      [resourceId, fields, eventFields],
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

/** One column of an UPDATE's `changes`: its values, or - for an excluded column - only that it changed. */
export type ColumnChange = { old: unknown; new: unknown } | { excluded: true };

/**
 * An UPDATE's `changes` (Security.md §11.4): `{ column: { old,
 * new } }` for every column the update changed; an excluded one that
 * changed is `{ column: { excluded: true } }` - that it changed, never what.
 * undefined when the old row isn't known (a table without a primary key on
 * PostgreSQL 15-17 - the entry keeps the resulting row) or nothing changed.
 */
export function buildUpdateChanges(
  oldRow: Record<string, unknown> | undefined,
  newRow: Record<string, unknown> | undefined,
  excluded: Set<string>,
): Record<string, ColumnChange> | undefined {
  if (!oldRow || !newRow) return undefined;
  const changes: Record<string, ColumnChange> = {};
  for (const field of Object.keys(newRow)) {
    if (!(field in oldRow)) continue;
    if (JSON.stringify(oldRow[field]) !== JSON.stringify(newRow[field])) {
      changes[field] = excluded.has(field) ? { excluded: true } : { old: oldRow[field], new: newRow[field] };
    }
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}
