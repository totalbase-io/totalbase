import type { Database } from "@totalbase/database";
import type { CatalogScope } from "./catalog-snapshot.js";

/**
 * A cheap summary of the catalog rows a sync reads (Foundations.md §12.4):
 * schemas, relations, columns, functions, constraints, types, enum labels,
 * view rules and comments. DDL adds, removes or rewrites one of those rows,
 * and a rewritten row carries the newest transaction id as its xmin - so the
 * row count and highest xmin of each catalog change with it. Statistics
 * (ANALYZE, VACUUM) are in-place updates and leave xmin alone; temporary
 * and PostgreSQL's own schemas are left out, so a session's temp tables
 * don't count as a change.
 *
 * Only ever compared for equality. A difference that isn't a real change
 * (a TRUNCATE rewrites its pg_class row) costs one sync that finds nothing;
 * catalog.refresh_interval_minutes' full sync remains the safety net for
 * anything this misses.
 */
export async function getCatalogFingerprint(database: Database, scope: CatalogScope = {}): Promise<string> {
  // What is left out of the catalog is left out here too (Foundations.md §12.3, §12.4): the excluded schemas, and
  // the relations that are no resource of their own - partitions and tables by inheritance (a TimescaleDB chunk), with
  // their columns, constraints, indexes and row types - so a chunk created every hour doesn't run a sync every hour
  // (the first child rewrites its parent's pg_class row once, relhassubclass: one sync that registers nothing).
  const { rows } = await database.query<{ fingerprint: string }>(
    `WITH ns AS (
       SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND nspname <> ALL($1::text[])
     ), base AS (
       SELECT oid, xmin FROM pg_class c
       WHERE relnamespace IN (SELECT oid FROM ns)
         AND NOT c.relispartition
         AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
     ), rel AS (
       -- An index of a relation left out goes with it.
       SELECT oid, xmin FROM base b
       WHERE NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = b.oid AND i.indrelid NOT IN (SELECT oid FROM base))
     )
     SELECT concat_ws('|',
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_namespace WHERE nspname <> ALL($1::text[])),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM rel),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_attribute WHERE attrelid IN (SELECT oid FROM rel)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_proc WHERE pronamespace IN (SELECT oid FROM ns)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_constraint WHERE connamespace IN (SELECT oid FROM ns) AND (conrelid = 0 OR conrelid IN (SELECT oid FROM rel))),
       -- A type that is a relation's row type, or the array of one, goes with the relation.
       (SELECT count(*) || '.' || coalesce(max(t.xmin::text::bigint), 0) FROM pg_type t
         WHERE t.typnamespace IN (SELECT oid FROM ns)
           AND (t.typrelid IN (SELECT oid FROM rel)
                OR (t.typrelid = 0 AND NOT EXISTS (SELECT 1 FROM pg_type e WHERE e.oid = t.typelem AND e.typrelid <> 0 AND e.typrelid NOT IN (SELECT oid FROM rel))))),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_enum),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_rewrite WHERE ev_class IN (SELECT oid FROM rel)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_description)
     ) AS fingerprint`,
    [scope.excludedSchemas ?? []],
  );
  return rows[0]!.fingerprint;
}
