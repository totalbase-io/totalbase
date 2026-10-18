import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/**
 * Reconstructed CREATE VIEW statement - runnable as is, like
 * pg_get_functiondef()'s: `CREATE OR REPLACE VIEW` (a materialized view:
 * `CREATE MATERIALIZED VIEW`, which has no OR REPLACE) with the name and
 * options quoted by PostgreSQL itself, `AS` and pg_get_viewdef()'s query.
 * Read-only introspection (Specification_Administration.md §4: "show DDL").
 */
export async function getViewDdl(database: Database, oid: number): Promise<string> {
  const { rows } = await database.query<{ ddl: string | null }>(
    `SELECT format('%s %I.%I%s AS', CASE c.relkind WHEN 'm' THEN 'CREATE MATERIALIZED VIEW' ELSE 'CREATE OR REPLACE VIEW' END,
                   n.nspname, c.relname,
                   CASE WHEN c.reloptions IS NULL THEN '' ELSE ' WITH (' || array_to_string(c.reloptions, ', ') || ')' END)
            || E'\n' || pg_get_viewdef(c.oid, true) AS ddl
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = $1::oid AND c.relkind IN ('v', 'm')`,
    [oid],
  );
  const ddl = rows[0]?.ddl;
  if (ddl === null || ddl === undefined) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `View not found: oid ${oid}`);
  }
  return ddl;
}

/** Reconstructed CREATE FUNCTION source, via PostgreSQL's own pg_get_functiondef(). */
export async function getFunctionDdl(database: Database, oid: number): Promise<string> {
  const { rows } = await database.query<{ ddl: string | null }>(
    `SELECT pg_get_functiondef($1::oid) AS ddl`,
    [oid],
  );
  const ddl = rows[0]?.ddl;
  if (ddl === null || ddl === undefined) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `Function not found: oid ${oid}`);
  }
  return ddl;
}
