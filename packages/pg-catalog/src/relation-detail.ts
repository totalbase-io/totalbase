import type { Database } from "@totalbase/database";
import { RelationDetailCache } from "./relation-detail-cache.js";

export interface ColumnDefinition {
  name: string;
  /**
   * pg_attribute.attnum - stable across a column rename (unlike `name`),
   * only changes on drop+recreate. DataView field bindings
   * (totalbase.dataviews_fields.column_attnum) key on this instead of
   * `name` for exactly that reason - see
   * Specification_DataViews.md §1.2.
   */
  attnum: number;
  /** PostgreSQL type name as returned by format_type(), e.g. "character varying(255)". */
  dataType: string;
  /** The type's name alone, no modifier - `character varying`, `numeric`, `text[]` - for an editor that keeps the parts apart. */
  typeName: string;
  /** A character type's declared length (`varchar(255)` → 255); null without one. */
  typeLength: number | null;
  /** A numeric's declared precision and scale (`numeric(12,2)` → 12 and 2); null without them. */
  typePrecision: number | null;
  typeScale: number | null;
  /**
   * The domain a column is declared with (`cuit`, schema-qualified outside the search path); null for a
   * plain type. `dataType`/`typeName` and the parts are then the domain's base type's (Specification.md §11.2).
   */
  domain: string | null;
  nullable: boolean;
  isIdentity: boolean;
  isGenerated: boolean;
  defaultExpression: string | null;
}

/** A single-column foreign key. Composite FKs are introspected elsewhere but not usable for relation traversal in V1. */
export interface RelationDefinition {
  /** Constraint name - needed to DROP it (admin schema-management routes take a name, not a column). */
  name: string;
  /** Source column name, e.g. "brand" in products.brand -> brands.id. */
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  /** What a user reads when a write breaks it - the constraint's COMMENT (Specification_Data_API.md §11.2). */
  message?: string | null;
}

/**
 * A single-column foreign key found on some OTHER table, pointing at the
 * table this was introspected for (the reverse of RelationDefinition).
 * Used to resolve nested-write child relations (Specification_Data_API.md §6.2):
 * "does some table have a FK back to this parent?".
 */
export interface ChildRelationDefinition {
  /** Constraint name, for diagnostics. */
  name: string;
  childOid: number;
  childSchema: string;
  childTable: string;
  /** FK column on the child table, e.g. "invoice" in invoice_items.invoice -> invoices.id. */
  childColumn: string;
  /** Column on the parent (this table) the FK targets, e.g. "id". */
  parentColumn: string;
}

export interface CheckConstraintDefinition {
  name: string;
  /** Full constraint definition as PostgreSQL renders it, e.g. "CHECK ((price > (0)::numeric))". */
  expression: string;
  /** The constraint's own COMMENT ("Error Message" in the admin) - shown in place of Postgres's generic CHECK_VIOLATION text when this constraint fails, see @totalbase/database's error mapper. null if never set. */
  message: string | null;
  /** The columns the expression names (pg_constraint.conkey) - one for a single-column CHECK. */
  columns: string[];
}

export interface RelationDetail {
  columns: ColumnDefinition[];
  primaryKey: string[];
  relations: RelationDefinition[];
  /** Each entry is one UNIQUE constraint's column set (order as declared). */
  uniqueConstraints: string[][];
  /**
   * Constraint name for each entry of `uniqueConstraints`, same index -
   * kept as a parallel array rather than folded into `uniqueConstraints`
   * itself so query-engine's existing `string[][]` consumers (row-set
   * matching for ON CONFLICT, Specification_Data_API.md §5.7) don't need to change.
   */
  uniqueConstraintNames: string[];
  /** Each UNIQUE constraint's message (its COMMENT), same index; null without one. */
  uniqueConstraintMessages: (string | null)[];
  checkConstraints: CheckConstraintDefinition[];
}

/**
 * The process-wide cache getRelationDetail() reads through - see
 * relation-detail-cache.ts for what clears it and when.
 */
export const relationDetailCache = new RelationDetailCache<RelationDetail>();

/**
 * Introspects columns, primary key, simple (single-column) foreign keys,
 * and UNIQUE constraints for a table/view by OID. See
 * Specification.md §12 and Specification_Data_API.md §3.4 (Relations derive from
 * real PostgreSQL FK); UNIQUE constraints are needed to validate
 * ON CONFLICT targets (Specification_Data_API.md §5.7).
 *
 * Read through `relationDetailCache`: PostgreSQL is asked once per
 * relation until something clears the cache (DDL TotalBase runs, a catalog
 * sync). Callers get the shared object - never mutate it.
 */
export function getRelationDetail(database: Database, oid: number): Promise<RelationDetail> {
  return relationDetailCache.get(database, oid, () => introspectRelationDetail(database, oid));
}

async function introspectRelationDetail(database: Database, oid: number): Promise<RelationDetail> {
  const [columns, primaryKey, relations, uniqueConstraintGroups, checkConstraints] = await Promise.all([
    getColumns(database, oid),
    getPrimaryKey(database, oid),
    getSimpleForeignKeys(database, oid),
    getUniqueConstraintGroups(database, oid),
    getCheckConstraints(database, oid),
  ]);
  return {
    columns,
    primaryKey,
    relations,
    uniqueConstraints: uniqueConstraintGroups.map((g) => g.columns),
    uniqueConstraintNames: uniqueConstraintGroups.map((g) => g.name),
    uniqueConstraintMessages: uniqueConstraintGroups.map((g) => g.message),
    checkConstraints,
  };
}

export interface IndexDefinition {
  name: string;
  /** Indexed columns, in index-key order. */
  columns: string[];
  /** The same keys with their direction (pg_index.indoption's DESC bit) - what an editor rebuilds the index from. */
  keys: { name: string; direction: "asc" | "desc" }[];
  isUnique: boolean;
  isPrimary: boolean;
  /** Access method, e.g. "btree", "gin", "gist" (pg_am.amname). */
  method: string;
  /** A partial index's WHERE, as PostgreSQL renders it; null for a whole-table index. */
  predicate: string | null;
}

/**
 * Introspects indexes for a table by OID - separate from getRelationDetail()
 * (not every caller needs it, same reasoning as view DDL living in its own
 * route rather than growing RelationDetail). Used by the table detail page's
 * Indexes section.
 */
export async function getRelationIndexes(database: Database, oid: number): Promise<IndexDefinition[]> {
  const { rows } = await database.query<{
    name: string;
    column_name: string;
    is_unique: boolean;
    is_primary: boolean;
    method: string;
    desc: boolean;
    predicate: string | null;
  }>(
    // indoption is 0-based (an int2vector): bit 0 of a key's option is INDOPTION_DESC.
    `SELECT ic.relname AS name, a.attname AS column_name, ix.indisunique AS is_unique,
            ix.indisprimary AS is_primary, am.amname AS method,
            (ix.indoption[k.ord - 1] & 1) = 1 AS "desc",
            pg_get_expr(ix.indpred, ix.indrelid) AS predicate
     FROM pg_index ix
     JOIN pg_class ic ON ic.oid = ix.indexrelid
     JOIN pg_am am ON am.oid = ic.relam
     JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
     WHERE ix.indrelid = $1
     ORDER BY ic.relname, k.ord`,
    [oid],
  );

  const byIndex = new Map<string, IndexDefinition>();
  for (const row of rows) {
    const entry = byIndex.get(row.name) ?? {
      name: row.name,
      columns: [],
      keys: [],
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      method: row.method,
      predicate: row.predicate,
    };
    entry.columns.push(row.column_name);
    entry.keys.push({ name: row.column_name, direction: row.desc ? "desc" : "asc" });
    byIndex.set(row.name, entry);
  }
  return [...byIndex.values()];
}

async function getColumns(database: Database, oid: number): Promise<ColumnDefinition[]> {
  const { rows } = await database.query<{
    attnum: number;
    name: string;
    data_type: string;
    type_name: string;
    type_length: number | null;
    type_precision: number | null;
    type_scale: number | null;
    domain: string | null;
    nullable: boolean;
    is_identity: boolean;
    is_generated: boolean;
    default_expression: string | null;
  }>(
    // The type's parts the way information_schema.columns derives them from atttypmod: a character type's
    // length is the modifier minus the 4-byte header; a numeric packs precision in the high 16 bits and
    // scale in the low ones. An editor edits them as their own cells - no need to parse format_type()'s text.
    //
    // A domain column reports its base type (a domain over a domain: the last one's), so every consumer
    // reads it as the value it holds - a `cuit` domain over text is text, edited with a text input - and its
    // name apart, in `domain`; its CHECK stays PostgreSQL's, enforced on every write.
    `SELECT
       a.attnum AS attnum,
       a.attname AS name,
       format_type(ty.oid, ty.mod) AS data_type,
       format_type(ty.oid, NULL) AS type_name,
       CASE WHEN ty.oid IN ('bpchar'::regtype, 'varchar'::regtype) AND ty.mod > 4 THEN ty.mod - 4 END AS type_length,
       CASE WHEN ty.oid = 'numeric'::regtype AND ty.mod > 4 THEN ((ty.mod - 4) >> 16) & 65535 END AS type_precision,
       CASE WHEN ty.oid = 'numeric'::regtype AND ty.mod > 4 THEN (ty.mod - 4) & 65535 END AS type_scale,
       CASE WHEN ty.oid <> a.atttypid THEN format_type(a.atttypid, NULL) END AS domain,
       NOT a.attnotnull AS nullable,
       a.attidentity <> '' AS is_identity,
       a.attgenerated <> '' AS is_generated,
       pg_get_expr(d.adbin, d.adrelid) AS default_expression
     FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     LEFT JOIN LATERAL (
       WITH RECURSIVE chain(base, mod, depth) AS (
         SELECT t.typbasetype, t.typtypmod, 1 FROM pg_type t WHERE t.oid = a.atttypid AND t.typtype = 'd'
         UNION ALL
         SELECT t.typbasetype, t.typtypmod, chain.depth + 1 FROM chain JOIN pg_type t ON t.oid = chain.base WHERE t.typtype = 'd'
       )
       SELECT base, mod FROM chain ORDER BY depth DESC LIMIT 1
     ) dom ON true
     CROSS JOIN LATERAL (
       SELECT coalesce(dom.base, a.atttypid) AS oid, CASE WHEN dom.base IS NULL THEN a.atttypmod ELSE dom.mod END AS mod
     ) ty
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [oid],
  );

  return rows.map((row) => ({
    attnum: row.attnum,
    name: row.name,
    dataType: row.data_type,
    typeName: row.type_name,
    typeLength: row.type_length,
    typePrecision: row.type_precision,
    typeScale: row.type_scale,
    domain: row.domain,
    nullable: row.nullable,
    isIdentity: row.is_identity,
    isGenerated: row.is_generated,
    defaultExpression: row.default_expression,
  }));
}

async function getPrimaryKey(database: Database, oid: number): Promise<string[]> {
  const { rows } = await database.query<{ name: string }>(
    `SELECT a.attname AS name
     FROM pg_constraint c
     JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = $1 AND c.contype = 'p'
     ORDER BY k.ord`,
    [oid],
  );
  return rows.map((row) => row.name);
}

async function getUniqueConstraintGroups(database: Database, oid: number): Promise<{ name: string; columns: string[]; message: string | null }[]> {
  const { rows } = await database.query<{ constraint_name: string; name: string; message: string | null }>(
    `SELECT c.conname AS constraint_name, a.attname AS name, obj_description(c.oid, 'pg_constraint') AS message
     FROM pg_constraint c
     JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = $1 AND c.contype = 'u'
     ORDER BY c.conname, k.ord`,
    [oid],
  );

  const byConstraint = new Map<string, { columns: string[]; message: string | null }>();
  for (const row of rows) {
    const entry = byConstraint.get(row.constraint_name) ?? { columns: [], message: row.message };
    entry.columns.push(row.name);
    byConstraint.set(row.constraint_name, entry);
  }
  return [...byConstraint.entries()].map(([name, entry]) => ({ name, ...entry }));
}

async function getCheckConstraints(database: Database, oid: number): Promise<CheckConstraintDefinition[]> {
  const { rows } = await database.query<{ name: string; expression: string; message: string | null; columns: string[] }>(
    `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS expression, obj_description(c.oid, 'pg_constraint') AS message,
            coalesce((SELECT array_agg(a.attname::text ORDER BY k.ord)
                        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum), '{}') AS columns
     FROM pg_constraint c
     WHERE c.conrelid = $1 AND c.contype = 'c'
     ORDER BY c.conname`,
    [oid],
  );
  return rows.map((row) => ({ name: row.name, expression: row.expression, message: row.message, columns: row.columns }));
}

async function getSimpleForeignKeys(database: Database, oid: number): Promise<RelationDefinition[]> {
  const { rows } = await database.query<{
    name: string;
    source_column: string;
    target_schema: string;
    target_table: string;
    target_column: string;
    message: string | null;
  }>(
    `SELECT
       c.conname AS name,
       a.attname AS source_column,
       tn.nspname AS target_schema,
       tc.relname AS target_table,
       ta.attname AS target_column,
       obj_description(c.oid, 'pg_constraint') AS message
     FROM pg_constraint c
     JOIN pg_class tc ON tc.oid = c.confrelid
     JOIN pg_namespace tn ON tn.oid = tc.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = c.confkey[1]
     WHERE c.conrelid = $1 AND c.contype = 'f' AND array_length(c.conkey, 1) = 1`,
    [oid],
  );

  return rows.map((row) => ({
    name: row.name,
    sourceColumn: row.source_column,
    targetSchema: row.target_schema,
    targetTable: row.target_table,
    targetColumn: row.target_column,
    message: row.message,
  }));
}

/**
 * Introspects single-column foreign keys on OTHER tables that point back
 * at this table (by OID) - the reverse of getSimpleForeignKeys. This is
 * what lets a nested-write payload like `"$invoice_items": []` resolve to
 * a real child-to-parent relationship (Specification_Data_API.md §6.2).
 * Composite FKs are excluded, same policy as the outgoing
 * side (V1 relation traversal only supports single-column FKs).
 */
export async function getChildForeignKeys(database: Database, parentOid: number): Promise<ChildRelationDefinition[]> {
  const { rows } = await database.query<{
    name: string;
    child_oid: number;
    child_schema: string;
    child_table: string;
    child_column: string;
    parent_column: string;
  }>(
    `SELECT
       c.conname AS name,
       tc.oid::int AS child_oid,
       tn.nspname AS child_schema,
       tc.relname AS child_table,
       a.attname AS child_column,
       ta.attname AS parent_column
     FROM pg_constraint c
     JOIN pg_class tc ON tc.oid = c.conrelid
     JOIN pg_namespace tn ON tn.oid = tc.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = c.confkey[1]
     WHERE c.confrelid = $1 AND c.contype = 'f' AND array_length(c.conkey, 1) = 1`,
    [parentOid],
  );

  return rows.map((row) => ({
    name: row.name,
    childOid: row.child_oid,
    childSchema: row.child_schema,
    childTable: row.child_table,
    childColumn: row.child_column,
    parentColumn: row.parent_column,
  }));
}
