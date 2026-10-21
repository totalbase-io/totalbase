import type { Database } from "@totalbase/database";

/**
 * Real Postgres schema names, independent of whether any table/view/
 * function exists in them yet - buildCatalogSnapshot below only sees
 * schemas that already contain at least one relation, so a schema created
 * but still empty (e.g. right after CREATE SCHEMA) would never appear
 * anywhere without this. Same exclusion filter buildCatalogSnapshot's own
 * queries already use (system/temp schemas).
 */
export async function listSchemas(database: Database): Promise<string[]> {
  const { rows } = await database.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema')
       AND nspname NOT LIKE 'pg\\_%'
     ORDER BY nspname`,
  );
  return rows.map((row) => row.nspname);
}

/**
 * TotalBase V1 public resource type. See Foundations.md §11.1.
 */
export type ResourceType = "TABLE" | "VIEW" | "FUNCTION";

/**
 * Underlying PostgreSQL object kind, preserved alongside the simplified
 * public resource type. See Foundations.md §11.2.
 */
export type RelationKind =
  | "ordinary_table"
  | "partitioned_table"
  | "view"
  | "materialized_view"
  | "function"
  | "procedure";

export interface CatalogObject {
  oid: number;
  schema: string;
  name: string;
  relationKind: RelationKind;
  /** Undefined for object kinds that are introspected but not exposable in V1 (e.g. procedures). */
  resourceType: ResourceType | undefined;
}

/**
 * Punctual exceptions to the totalbase schema's reservation
 * (Security.md §10.1): every totalbase.* table gets a real totalbase.resources
 * row and can be granted through the ordinary ALLOW/DENY + row filter +
 * field grant model, gated by the hard-coded floor in
 * apps/server/src/totalbase-guardrails.ts (access/reserved on roles can
 * never be written, a user can never be assigned to an admin/reserved
 * role, and password_hash/token_hash/ciphertext-shaped columns can never
 * be read or written - see PROTECTED_FIELDS there) rather than relying
 * only on how an operator configures a grant.
 *
 * `instance` is kept off this list - a single immutable
 * bootstrap row with nothing to grant.
 * `tokens` (personal access tokens) is exposable since the Admin
 * API plan (Security.md §10): listed, renamed, revoked
 * and deleted as rows, its key_hash protected and its other columns fixed
 * by PostgreSQL; issuing and rotating stay TotalBase's.
 */
const EXPOSABLE_TOTALBASE_TABLES = [
  // Files authorizes through its own resource row (apps/server/src/
  // files-authorization.ts) - without it every upload
  // through the Data API fails with FILE_ACCESS_DENIED.
  "files",
  "logs",
  "providers",
  "emails_tokens",
  "executions",
  "idempotency_keys",
  "outbox",
  "permissions",
  "resources",
  "audits_exclusions",
  "roles",
  "migrations",
  "secrets",
  "sessions",
  "settings",
  "sql_queries",
  "templates",
  "roles_capabilities",
  // Access reviews (Security.md §1.8) - administrator-written attestations.
  "roles_reviews",
  "users",
  "identities",
  "users_roles",
  // Object access and the App menu (Security.md §7.1, §8) -
  // readable under ordinary permissions, written by administrators only
  // (packages/mutations' assertAdminWrittenTable).
  "dataviews_roles",
  "dashboards_roles",
  "menus",
  // Delegated administration (Security.md §9, §9.4).
  "folders",
  "roles_managers",
  "tokens",
];

const RELATION_KIND_BY_RELKIND: Record<string, { relationKind: RelationKind; resourceType: ResourceType }> = {
  r: { relationKind: "ordinary_table", resourceType: "TABLE" },
  p: { relationKind: "partitioned_table", resourceType: "TABLE" },
  v: { relationKind: "view", resourceType: "VIEW" },
  m: { relationKind: "materialized_view", resourceType: "VIEW" },
};

/**
 * The relations that are resources of their own (Foundations.md §12):
 * not a partition - a storage detail of its partitioned parent, which is
 * the resource; a partition registered beside it could be exposed and
 * granted apart, its rows read past the parent's grants - and not an
 * extension's member, which belongs to the extension, not the application.
 * `alias` is the pg_class alias of the query it goes into.
 */
export function resourceRelationSql(alias: string): string {
  return `NOT ${alias}.relispartition
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                       WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`;
}

/**
 * The functions that are resources of their own: not a trigger or event
 * trigger function - PostgreSQL can't call one directly ("trigger functions
 * can only be called as triggers"), so its endpoint could only fail - and
 * not an extension's member. `alias` is the pg_proc alias.
 */
export function resourceFunctionSql(alias: string): string {
  return `${alias}.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                       WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`;
}

/**
 * Introspects pg_catalog for supported tables, views and functions,
 * excluding reserved schemas. See Foundations.md §12.
 *
 * Column/PK/FK/CHECK/index-level introspection belongs to later phases;
 * this snapshot only establishes object identity for resource reconciliation.
 */
export async function buildCatalogSnapshot(database: Database): Promise<CatalogObject[]> {
  const relations = await database.query<{
    oid: number;
    schema: string;
    name: string;
    relkind: string;
  }>(
    `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_%'
       -- TotalBase's own tables: only the ones it exposes (EXPOSABLE_TOTALBASE_TABLES); its schema is the signal.
       AND (n.nspname <> 'totalbase' OR c.relname = ANY($1))
       AND ${resourceRelationSql("c")}
     ORDER BY n.nspname, c.relname`,
    [EXPOSABLE_TOTALBASE_TABLES],
  );

  const functions = await database.query<{
    oid: number;
    schema: string;
    name: string;
    prokind: string;
  }>(
    `SELECT p.oid::int AS oid, n.nspname AS schema, p.proname AS name, p.prokind AS prokind
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_%'
       AND p.prokind IN ('f', 'p')
       -- TotalBase's own internal functions (instance_protect_id...) are never resources: its schema holds them.
       AND n.nspname <> 'totalbase'
       AND ${resourceFunctionSql("p")}
     ORDER BY n.nspname, p.proname`,
  );

  const objects: CatalogObject[] = [];

  for (const row of relations.rows) {
    const mapped = RELATION_KIND_BY_RELKIND[row.relkind];
    if (!mapped) continue;
    objects.push({
      oid: row.oid,
      schema: row.schema,
      name: row.name,
      relationKind: mapped.relationKind,
      resourceType: mapped.resourceType,
    });
  }

  for (const row of functions.rows) {
    const isProcedure = row.prokind === "p";
    objects.push({
      oid: row.oid,
      schema: row.schema,
      name: row.name,
      relationKind: isProcedure ? "procedure" : "function",
      // Procedures are introspected but not exposable in V1 (Foundations.md §11.2).
      resourceType: isProcedure ? undefined : "FUNCTION",
    });
  }

  return objects;
}

export interface RelationColumns {
  oid: number;
  schema: string;
  name: string;
  resourceType: ResourceType;
  /** Column names in attnum order (dropped columns excluded). */
  columns: string[];
}

/**
 * Every table's and view's column names in one schema, in one query - the
 * SQL Console's completion, which would otherwise fetch each relation's
 * detail separately. The same relations as buildCatalogSnapshot (TotalBase's
 * own tables only where exposable); a reserved or unknown schema has none.
 */
export async function listRelationColumns(database: Database, schema: string): Promise<RelationColumns[]> {
  const { rows } = await database.query<{ oid: number; schema: string; name: string; relkind: string; columns: string[] }>(
    `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS relkind,
            coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped), '{}') AS columns
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = $1
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_%'
       AND (n.nspname <> 'totalbase' OR c.relname = ANY($2))
     GROUP BY c.oid, n.nspname, c.relname, c.relkind
     ORDER BY c.relname`,
    [schema, EXPOSABLE_TOTALBASE_TABLES],
  );
  return rows.map((row) => ({
    oid: row.oid,
    schema: row.schema,
    name: row.name,
    resourceType: RELATION_KIND_BY_RELKIND[row.relkind]!.resourceType,
    columns: row.columns,
  }));
}
