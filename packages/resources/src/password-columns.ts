import type { Database } from "@totalbase/database";

/**
 * Which columns of a resource are password columns (their presentation's
 * `input` is `password` - Add Column's entry, never changed after) - the source of truth
 * apps/server's password-fields.ts hashes-on-write/denies-on-read against.
 * Looked up fresh per request, same "no caching layer" convention
 * resolveTableResource's own per-request resources lookup
 * already follows - own file rather than pg-sync.ts, which is about
 * Pull/Push sync semantics, not a plain read.
 */
export async function getPasswordColumns(database: Database, resourceId: string): Promise<Set<string>> {
  const { rows } = await database.query<{ name: string }>(
    `SELECT name FROM totalbase.resources_columns WHERE resource = $1 AND config ->> 'input' = 'password'`,
    [resourceId],
  );
  return new Set(rows.map((row) => row.name));
}
