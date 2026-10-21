import type { Database, Queryable } from "@totalbase/database";
import { getRelationDetail } from "@totalbase/pg-catalog";
import { quoteIdentifier } from "@totalbase/schema";
import { TotalBaseError } from "@totalbase/errors";

export interface SyncColumnsResult {
  discovered: number;
  renamed: number;
  removed: number;
}

/**
 * Pull direction of pg-sync (Foundations.md §11.8):
 * the resource-level sibling of reconcileResources(), one level down. Keeps
 * totalbase.resources_columns in step with a TABLE or VIEW resource's real
 * Postgres columns. Push (the CREATE TABLE wizard / add-column modal writing this
 * table directly with an explicit widget choice) is not built; adding a column
 * from the designer is Not planned (Roadmap_v2.md §4.17).
 *
 * A column it has never seen before (by attnum) gets its row with no
 * presentation - its control is the rule's (Automatic, `columnFormInput`);
 * an existing row's presentation is never overwritten here. Only name is
 * kept in sync on every pass, the same "identity by attnum, display fields
 * follow" rule reconcile-resources.ts already applies to postgres_oid's own
 * schema/name at the resource level.
 */
export async function syncResourceColumns(
  database: Database,
  resourceId: string,
  postgresOid: number,
): Promise<SyncColumnsResult> {
  const detail = await getRelationDetail(database, postgresOid);

  // Set-based: the catalog's columns as one jsonb array, one UPDATE for the renames, one
  // INSERT for the new ones - two syncs at once both see no row for a new column: PostgreSQL decides who writes
  // it, never a UNIQUE violation (AGENTS.md section 16).
  const input = JSON.stringify(detail.columns.map((column) => ({ attnum: column.attnum, name: column.name })));
  const INPUT = `jsonb_to_recordset($2::jsonb) AS i(attnum int, name text)`;
  const { rowCount: renamed } = await database.query(
    `UPDATE totalbase.resources_columns c SET name = i.name, updated_at = now()
     FROM ${INPUT}
     WHERE c.resource = $1 AND c.attnum = i.attnum AND c.name <> i.name`,
    [resourceId, input],
  );
  const { rowCount: discovered } = await database.query(
    `INSERT INTO totalbase.resources_columns (resource, attnum, name)
     SELECT $1, i.attnum, i.name FROM ${INPUT}
     ON CONFLICT (resource, attnum) DO NOTHING`,
    [resourceId, input],
  );

  const seenAttnums = detail.columns.map((column) => column.attnum);
  const { rowCount: removed } = await database.query(
    `DELETE FROM totalbase.resources_columns
     WHERE resource = $1 AND NOT (attnum = ANY($2::int[]))`,
    [resourceId, seenAttnums],
  );

  return { discovered, renamed, removed };
}

/**
 * Each column's chosen control - its presentation's `input`, a COLUMN_INPUTS key (Add Column's, or the Columns
 * tab's) - by name: what a new DataView's fields start with (dataviews-admin-service.ts's create()/syncFields()). A
 * column with none isn't in it: the rule decides.
 */
export async function getColumnInputs(database: Database, resourceId: string): Promise<Map<string, string>> {
  const { rows } = await database.query<{ name: string; input: string }>(
    `SELECT name, config ->> 'input' AS input FROM totalbase.resources_columns WHERE resource = $1 AND config ? 'input'`,
    [resourceId],
  );
  return new Map(rows.map((row) => [row.name, row.input]));
}

export interface PushColumnPresentationInput {
  schema: string;
  table: string;
  columnName: string;
  /** Its presentation - its `input` (Add Column's entry) among it. */
  config: unknown;
}

/**
 * Push direction of pg-sync (Foundations.md §11.8) -
 * the path syncResourceColumns' own doc comment above calls "a separate,
 * not-yet-built path". Called right after the Add Column wizard's own
 * `ADD COLUMN` succeeds (DataViews.md §16.2), with the
 * column's presentation - the entry the user picked (`input`) among it:
 * the real choice is already known, never re-decided by the rule.
 *
 * Looks the new column up by name rather than taking its attnum as a
 * parameter - the caller (the admin-schema.ts route) only has the column
 * name it just sent to ADD COLUMN, not its attnum, which Postgres only
 * assigns once the column exists. Takes any Queryable, so the route runs
 * it in the ADD COLUMN's own transaction: no ACTIVE resource rolls the
 * column back too.
 */
export async function pushColumnPresentation(database: Queryable, input: PushColumnPresentationInput): Promise<void> {
  const { rows: resourceRows } = await database.query<{ id: string; postgres_oid: number }>(
    `SELECT id, postgres_oid FROM totalbase.resources WHERE "schema" = $1 AND name = $2 AND type = 'TABLE' AND status = 'ACTIVE'`,
    [input.schema, input.table],
  );
  const resource = resourceRows[0];
  if (!resource) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `No active TABLE resource for ${input.schema}.${input.table}`);
  }

  const { rows: attributeRows } = await database.query<{ attnum: number }>(
    `SELECT attnum FROM pg_attribute WHERE attrelid = $1 AND attname = $2 AND NOT attisdropped`,
    [resource.postgres_oid, input.columnName],
  );
  const attribute = attributeRows[0];
  if (!attribute) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `Column ${input.columnName} not found on ${input.schema}.${input.table} after ADD COLUMN`);
  }

  await database.query(
    `INSERT INTO totalbase.resources_columns (resource, attnum, name, config)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (resource, attnum)
     DO UPDATE SET name = $3, config = $4, updated_at = now()`,
    [resource.id, attribute.attnum, input.columnName, JSON.stringify(input.config ?? {})],
  );
}

export interface DropColumnWidgetInput {
  schema: string;
  table: string;
  columnName: string;
}

/**
 * The DROP COLUMN counterpart to pushColumnPresentation() above - without this,
 * a column dropped through the admin route (ResourceColumns.vue's trash
 * button) leaves its resources_columns row behind until the next manual
 * "Sync resources" pass (syncResourceColumns' own DELETE ... NOT attnum =
 * ANY(...) cleanup), which nothing prompts the user to run. Matched by
 * name rather than attnum: DROP COLUMN doesn't remove the
 * pg_attribute row, it renames it to a mangled "........pg.dropped.N....
 * ...." and sets attisdropped, so looking attnum back up by the column's
 * real name the way pushColumnPresentation does no longer works post-drop.
 */
export async function dropColumnWidget(database: Database, input: DropColumnWidgetInput): Promise<void> {
  await database.query(
    `DELETE FROM totalbase.resources_columns
     WHERE name = $3
       AND resource = (SELECT id FROM totalbase.resources WHERE "schema" = $1 AND name = $2 AND type = 'TABLE')`,
    [input.schema, input.table, input.columnName],
  );
}

export interface SyncDescriptionsResult {
  filledFromComment: number;
  filledFromDescription: number;
}

/**
 * A second Pull/Push pair, at the resource level rather than the column
 * level: keeps `description` (Foundations.md §11,
 * the superseded-design note) and Postgres's own native `COMMENT ON` in
 * step, restoring the external-tool-interop property that note said was
 * traded away when `description` became a plain column - without
 * reintroducing the ordering/atomicity problem that motivated the trade,
 * since this runs as its own sync pass, not required to happen atomically
 * with CREATE TABLE.
 *
 * Conflict rule, deliberately conservative: only fills whichever side is
 * empty from the side that has a value. Never overwrites one with the
 * other when both are already set, even if they differ - Postgres's
 * `COMMENT ON` carries no timestamp to arbitrate "which is newer", and a
 * silent overwrite could discard an intentional edit on either side. A
 * genuine divergence is left alone.
 *
 * TABLE/VIEW only. FUNCTION is out of scope for the Push side: `COMMENT ON
 * FUNCTION` needs the full argument-type signature to target the right
 * overload, which `resources` doesn't carry - not attempted here.
 */
export async function syncResourceDescriptions(database: Database): Promise<SyncDescriptionsResult> {
  const { rows } = await database.query<{
    id: string;
    schema: string;
    name: string;
    type: "TABLE" | "VIEW";
    /** What COMMENT ON names it: a VIEW resource may be a materialized view. */
    comment_target: "TABLE" | "VIEW" | "MATERIALIZED VIEW";
    description: string | null;
    comment: string | null;
  }>(
    `SELECT r.id, r."schema", r.name, r.type, r.description, obj_description(r.postgres_oid, 'pg_class') AS comment,
            CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS comment_target
     FROM totalbase.resources r
     JOIN pg_catalog.pg_class c ON c.oid = r.postgres_oid
     WHERE r.status = 'ACTIVE' AND r.type IN ('TABLE', 'VIEW')`,
  );

  let filledFromComment = 0;
  let filledFromDescription = 0;

  for (const row of rows) {
    if (row.description === null && row.comment !== null) {
      await database.query(
        `UPDATE totalbase.resources SET description = $2, updated_at = now() WHERE id = $1`,
        [row.id, row.comment],
      );
      filledFromComment += 1;
      continue;
    }

    if (row.description !== null && row.comment === null) {
      // COMMENT ON's grammar takes a string constant, not an expression -
      // no bind parameter for the literal, same rule table-schema-service.ts's
      // buildCommentOnConstraintSql already follows.
      const literal = `'${row.description.replace(/'/g, "''")}'`;
      await database.query(
        `COMMENT ON ${row.comment_target} ${quoteIdentifier(row.schema)}.${quoteIdentifier(row.name)} IS ${literal}`,
      );
      filledFromDescription += 1;
    }
  }

  return { filledFromComment, filledFromDescription };
}

/**
 * Runs syncResourceColumns() for every ACTIVE TABLE and VIEW resource - the
 * bulk entry point paired with reconcileResources() at the "Sync resources"
 * action (admin-catalog.ts's POST /admin/api/catalog/refresh). A VIEW's
 * columns carry a presentation too (DataViews.md §15)
 * - a DataView over a view inherits it the same way.
 * FUNCTION has no columns.
 */
export async function syncAllResourceColumns(database: Database): Promise<SyncColumnsResult> {
  const { rows: tables } = await database.query<{ id: string; postgres_oid: number }>(
    `SELECT id, postgres_oid FROM totalbase.resources WHERE type IN ('TABLE', 'VIEW') AND status = 'ACTIVE'`,
  );

  const total: SyncColumnsResult = { discovered: 0, renamed: 0, removed: 0 };
  for (const table of tables) {
    const result = await syncResourceColumns(database, table.id, table.postgres_oid);
    total.discovered += result.discovered;
    total.renamed += result.renamed;
    total.removed += result.removed;
  }
  return total;
}
