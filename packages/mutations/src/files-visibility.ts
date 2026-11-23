import { SchemaContext, compileFilter, mutationFilterContext, quoteIdentifier, relatedResolver } from "@totalbase/query-engine";
import type { DataPrincipal } from "./context.js";
import { buildRowFilter, userVariableResolver, type Limits } from "./mutation-service.js";
import { loadPasswordColumns, withPasswordColumnsDenied } from "./password-fields.js";
import { protectedFieldDecision } from "./totalbase-guardrails.js";
import type { TableAuthorizationContext } from "./table-row-authorization.js";

/**
 * A file's visibility as SQL (Administration.md §10.6): the ceiling every READ, UPDATE and DELETE of
 * `totalbase.files` is held to, whatever the grant says. A file is reached by its uploader (`created_by`), or - when
 * it isn't PRIVATE - by whoever may read a row that references it: one `EXISTS` per single-column foreign key to
 * `totalbase.files` from an ACTIVE, readable table, with the caller's own row filter on that table and an ALLOW on
 * the file column. Built here once, for the Data API's reads and the Files routes; PostgreSQL evaluates it in the
 * statement that reads the file.
 *
 * Undefined for an administrator: no permission holds them, this one neither.
 */
export type FilesVisibility = (alias: string, paramOffset: number) => Promise<{ sql: string; params: unknown[] }>;

let existsAliasCounter = 0;

export async function filesVisibility(
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  limits: Limits,
): Promise<FilesVisibility | undefined> {
  if (await context.effectivePermissions.isAdministrators(dataPrincipal.roleIds)) return undefined;
  const links = await linkingColumns(context);
  const schemaContext = new SchemaContext(context.database);
  const userVariable = userVariableResolver(dataPrincipal);

  // What links a file for this caller: each file column they may read, with their row filter on its table.
  const readable: { schema: string; table: string; column: string; root: Awaited<ReturnType<SchemaContext["loadRoot"]>>; filter: ReturnType<typeof buildRowFilter> }[] = [];
  for (const link of links) {
    const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, link.resource, "READ");
    if (permission.action !== "ALLOW") continue;
    const root = await schemaContext.loadRoot(link.schema, link.table, link.oid);
    const fieldDecision = withPasswordColumnsDenied(protectedFieldDecision(root, permission.fieldDecision), await loadPasswordColumns(context, link.resource));
    if (fieldDecision(link.column) !== "ALLOW") continue;
    readable.push({ schema: link.schema, table: link.table, column: link.column, root, filter: buildRowFilter(permission, limits) });
  }

  const owner = dataPrincipal.actorUserId ?? (dataPrincipal.userRow?.["id"] as string | undefined) ?? null;
  return async (alias, paramOffset) => {
    const params: unknown[] = [];
    const own = owner ? `${alias}.created_by = $${paramOffset + params.push(owner)}` : "false";
    const exists: string[] = [];
    for (const link of readable) {
      const row = `__file_link${++existsAliasCounter}`;
      let condition = `${row}.${quoteIdentifier(link.column)} = ${alias}.id`;
      if (link.filter) {
        const compiled = await compileFilter(link.filter, mutationFilterContext(link.root, row, userVariable, relatedResolver(schemaContext)), paramOffset + params.length);
        params.push(...compiled.params);
        condition += ` AND (${compiled.sql})`;
      }
      exists.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(link.schema)}.${quoteIdentifier(link.table)} AS ${row} WHERE ${condition})`);
    }
    const linked = exists.length ? ` OR (${alias}.visibility <> 'PRIVATE' AND (${exists.join(" OR ")}))` : "";
    return { sql: `(${own}${linked})`, params };
  };
}

/** Every single-column foreign key to `totalbase.files`, from a table that is an ACTIVE resource the Data API reads. */
async function linkingColumns(context: TableAuthorizationContext) {
  const { rows } = await context.database.query<{ schema: string; table: string; column: string; oid: number; resource: string }>(
    `SELECT n.nspname AS "schema", c.relname AS "table", a.attname AS "column", c.oid::int AS oid, r.id AS resource
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
       JOIN totalbase.resources r ON r.postgres_oid = k.conrelid AND r.status = 'ACTIVE' AND r.type = 'TABLE' AND 'GET' = ANY(r.exposed_methods)
      WHERE k.contype = 'f' AND k.confrelid = 'totalbase.files'::regclass AND cardinality(k.conkey) = 1
      ORDER BY 1, 2, 3`,
  );
  return rows;
}

/** A read's `rowCeiling` (compileSelect): the visibility when the resource read is `totalbase.files`, else none. */
export async function readCeiling(
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  resource: { schema: string; name: string },
  limits: Limits,
): Promise<FilesVisibility | undefined> {
  return resource.schema === "totalbase" && resource.name === "files" ? filesVisibility(context, dataPrincipal, limits) : undefined;
}
