import type { QueryResultRow } from "pg";
import type { Queryable } from "./database.js";
import { quoteIdentifier } from "./identifiers.js";

/**
 * The one versioning model (Foundations.md §13) in SQL, shared by the
 * three pillars that have it - DataViews, Dashboards and Workflows. Each
 * keeps its own identity table (the draft) and a `*_versions` table whose
 * rows are immutable snapshots numbered from 1; the live version is always
 * MAX(version). What differs per pillar is only *what* a snapshot holds
 * (its columns) and what each service validates around it - never how a
 * version is numbered, compared, inserted or purged. That shared part lives
 * here, so a rule such as "a number is never reused" is fixed once.
 */
export interface VersionsTable {
  /** The versions table, schema-qualified - `totalbase.dataviews_versions`. */
  table: string;
  /** The column that points at the owner - `dataview`, `dashboard`, `workflow`. */
  owner: string;
  /** The owner's own table, schema-qualified - the row a publish locks. */
  ownerTable: string;
  /** The columns a version row is answered with (summary, no snapshot payloads) - the pillar's `VERSION_COLUMNS`. */
  columns: string;
}

/**
 * One snapshot column of a version: a value (bound as a parameter, `cast`
 * when the column is `jsonb`), or an SQL expression PostgreSQL computes in
 * the same statement it is compared or stored in - `$1` inside it is the
 * owner id (a DataView's inherited presentation is one).
 */
export type VersionSnapshotColumn = { column: string; value: unknown; cast?: "jsonb" } | { column: string; expression: string };

const qualify = (name: string) => name.split(".").map(quoteIdentifier).join(".");

/**
 * Publishes a draft as the next version (Foundations.md §13.4), inside
 * the caller's transaction: locks the owner's row (two publishes at once
 * queue up, and the second finds the first's version instead of inserting
 * the same number), takes the snapshot through `snapshot` - read under
 * that lock, so it is the draft as committed - and then either answers the
 * latest version when the snapshot equals it (a no-op publish), or inserts
 * MAX(version) + 1 with `restored_from_version` = the newest OLDER version
 * holding the same snapshot (a Restore that was published, §13.4; null
 * otherwise). Returns the version row (`columns`), existing or inserted.
 */
export async function publishVersion<Row extends QueryResultRow>(
  client: Queryable,
  versions: VersionsTable,
  ownerId: string,
  userId: string | null,
  snapshot: (client: Queryable) => Promise<VersionSnapshotColumn[]>,
  /** The publisher's note on what this version changes (Foundations.md §13.3) - kept only when a version is created. */
  note: string | null = null,
): Promise<Row> {
  await client.query(`SELECT 1 FROM ${qualify(versions.ownerTable)} WHERE id = $1 FOR UPDATE`, [ownerId]);
  const columns = await snapshot(client);

  const table = qualify(versions.table);
  const owner = quoteIdentifier(versions.owner);
  const params: unknown[] = [ownerId];
  // Each column as it reads in a comparison and in the INSERT's VALUES - a bound parameter or the expression.
  const terms = columns.map((c) => {
    if ("expression" in c) return c.expression;
    params.push(c.value);
    return `$${params.length}${c.cast ? `::${c.cast}` : ""}`;
  });
  const equals = columns.map((c, i) => `${quoteIdentifier(c.column)} = ${terms[i]}`).join(" AND ");

  const { rows: unchanged } = await client.query<Row>(
    `SELECT ${versions.columns} FROM ${table}
     WHERE ${owner} = $1 AND version = (SELECT MAX(version) FROM ${table} WHERE ${owner} = $1)
       AND ${equals}`,
    params,
  );
  if (unchanged[0]) return unchanged[0];

  params.push(userId, note);
  const { rows } = await client.query<Row>(
    `INSERT INTO ${table} (${owner}, version, restored_from_version, ${columns.map((c) => quoteIdentifier(c.column)).join(", ")}, "user", note)
     VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM ${table} WHERE ${owner} = $1),
             (SELECT MAX(version) FROM ${table} WHERE ${owner} = $1 AND ${equals}),
             ${terms.join(", ")}, $${params.length - 1}, $${params.length})
     RETURNING ${versions.columns}`,
    params,
  );
  return rows[0]!;
}

/**
 * Deletes every version numbered below `before` (Foundations.md §13.4) -
 * never the live (latest) one, so the next publish stays latest + 1 and a
 * number is never reused. `keep` is an extra SQL condition a version must
 * meet to go, over the alias `v` (Workflows keeps a version that still has
 * runs). Returns the numbers deleted, ascending.
 */
export async function deleteVersionsBefore(client: Queryable, versions: VersionsTable, ownerId: string, before: number, keep?: string): Promise<number[]> {
  const table = qualify(versions.table);
  const owner = quoteIdentifier(versions.owner);
  const { rows } = await client.query<{ version: number }>(
    `DELETE FROM ${table} v
      WHERE v.${owner} = $1 AND v.version < $2
        AND v.version < (SELECT MAX(version) FROM ${table} WHERE ${owner} = $1)
        ${keep ? `AND ${keep}` : ""}
      RETURNING v.version`,
    [ownerId, before],
  );
  return rows.map((r) => r.version).sort((a, b) => a - b);
}
