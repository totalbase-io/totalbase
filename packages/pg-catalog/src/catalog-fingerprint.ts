import type { Database } from "@totalbase/database";

/**
 * A cheap summary of the catalog rows a sync reads (Specification.md §12.4):
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
export async function getCatalogFingerprint(database: Database): Promise<string> {
  const { rows } = await database.query<{ fingerprint: string }>(
    `WITH ns AS (
       SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
     ), rel AS (
       SELECT oid, xmin FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns)
     )
     SELECT concat_ws('|',
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_namespace),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM rel),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_attribute WHERE attrelid IN (SELECT oid FROM rel)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_proc WHERE pronamespace IN (SELECT oid FROM ns)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_constraint WHERE connamespace IN (SELECT oid FROM ns)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_type WHERE typnamespace IN (SELECT oid FROM ns)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_enum),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_rewrite WHERE ev_class IN (SELECT oid FROM rel)),
       (SELECT count(*) || '.' || coalesce(max(xmin::text::bigint), 0) FROM pg_description)
     ) AS fingerprint`,
  );
  return rows[0]!.fingerprint;
}
