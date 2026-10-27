import type { Queryable } from "@totalbase/database";
import { quoteIdentifier } from "@totalbase/database";

/**
 * The publication realtime subscriptions replicate (Data_API.md §16.2): exactly the ACTIVE tables exposing
 * `REALTIME`. Created with the first one - never by a migration, so a role without `CREATE` on the database
 * installs as before - and kept in step by an exposure change and by every reconcile.
 */
export const REALTIME_PUBLICATION = "totalbase_realtime";

/** A single-column primary key - what a change names its rows by, and what PostgreSQL needs to publish UPDATE and DELETE. */
export const SINGLE_COLUMN_KEY_SQL = (oid: string) =>
  `EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = ${oid} AND i.indisprimary AND i.indnkeyatts = 1)`;

/**
 * Takes `REALTIME` off the tables that can no longer have it (gone, no longer exposing GET, primary key
 * dropped or widened) and makes the publication hold exactly the tables that do. PostgreSQL's own error
 * when it can't - a table the role doesn't own - is the caller's.
 */
export async function syncRealtimePublication(client: Queryable): Promise<void> {
  await client.query(
    `UPDATE totalbase.resources r
     SET exposed_methods = array_remove(r.exposed_methods, 'REALTIME'), updated_at = now()
     WHERE 'REALTIME' = ANY(r.exposed_methods)
       AND (r.status <> 'ACTIVE' OR r.type <> 'TABLE' OR NOT 'GET' = ANY(r.exposed_methods)
            OR NOT ${SINGLE_COLUMN_KEY_SQL("r.postgres_oid")})`,
  );
  const { rows: wanted } = await client.query<{ oid: number; relation: string }>(
    `SELECT r.postgres_oid::int AS oid, r.postgres_oid::regclass::text AS relation
     FROM totalbase.resources r
     WHERE r.status = 'ACTIVE' AND r.type = 'TABLE' AND 'REALTIME' = ANY(r.exposed_methods)
     ORDER BY 1`,
  );
  const { rows: publications } = await client.query<{ oid: number }>(
    `SELECT oid::int AS oid FROM pg_catalog.pg_publication WHERE pubname = $1`,
    [REALTIME_PUBLICATION],
  );
  const publication = quoteIdentifier(REALTIME_PUBLICATION);
  if (publications.length === 0) {
    if (wanted.length === 0) return;
    await client.query(
      `CREATE PUBLICATION ${publication} FOR TABLE ${wanted.map((row) => row.relation).join(", ")}
       WITH (publish_via_partition_root = true)`,
    );
    return;
  }
  const { rows: published } = await client.query<{ oid: number; relation: string }>(
    `SELECT prrelid::int AS oid, prrelid::regclass::text AS relation FROM pg_catalog.pg_publication_rel WHERE prpubid = $1`,
    [publications[0]!.oid],
  );
  const wantedOids = new Set(wanted.map((row) => row.oid));
  const publishedOids = new Set(published.map((row) => row.oid));
  const add = wanted.filter((row) => !publishedOids.has(row.oid));
  const drop = published.filter((row) => !wantedOids.has(row.oid));
  if (add.length > 0) await client.query(`ALTER PUBLICATION ${publication} ADD TABLE ${add.map((row) => row.relation).join(", ")}`);
  if (drop.length > 0) await client.query(`ALTER PUBLICATION ${publication} DROP TABLE ${drop.map((row) => row.relation).join(", ")}`);
}
