import type { Queryable } from "@totalbase/database";

/** One column of a relation, as `pg_attribute` has it. */
export interface CatalogAttribute {
  /** The relation's OID. */
  relation: number;
  name: string;
  /** `pg_attribute.attnum` - survives a rename. */
  attnum: number;
  /** `format_type` with its modifier - `character varying(20)`, `numeric(12,2)`. */
  type: string;
  typeId: number;
}

/**
 * The live columns of some relations (Foundations.md §12) - user columns, dropped ones left out - in each
 * relation's column order. A relation is an OID or a name PostgreSQL resolves (`totalbase.users`, `to_regclass`): one
 * that resolves to nothing has no columns, so the caller says what's missing. One query for any number of relations.
 */
export async function listAttributes(database: Queryable, relations: ReadonlyArray<number | string>): Promise<CatalogAttribute[]> {
  if (relations.length === 0) return [];
  const { rows } = await database.query<CatalogAttribute>(
    `SELECT a.attrelid::int AS relation, a.attname AS name, a.attnum::int AS attnum,
            format_type(a.atttypid, a.atttypmod) AS type, a.atttypid::int AS "typeId"
     FROM pg_catalog.pg_attribute a
     WHERE (a.attrelid = ANY($1::oid[]) OR a.attrelid = ANY(SELECT to_regclass(name) FROM unnest($2::text[]) AS name)) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`,
    [relations.filter((r) => typeof r === "number"), relations.filter((r) => typeof r === "string")],
  );
  return rows;
}

/** A relation's primary key when it is one column - its name and type - else null (none, or a composite one). */
export async function singleColumnPrimaryKey(database: Queryable, relation: number | string): Promise<{ name: string; typeId: number } | null> {
  const { rows } = await database.query<{ name: string; typeId: number }>(
    `SELECT a.attname AS name, a.atttypid::int AS "typeId"
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = ${typeof relation === "number" ? "$1::oid" : "to_regclass($1::text)"} AND i.indisprimary AND i.indnkeyatts = 1`,
    [relation],
  );
  return rows[0] ?? null;
}

/** The name of a table's first constraint of a kind (`p` primary key, `u` unique, `f` foreign key, `c` check), else null. */
export async function findConstraintName(database: Queryable, schema: string, table: string, contype: "p" | "u" | "f" | "c"): Promise<string | null> {
  const { rows } = await database.query<{ conname: string }>(
    `SELECT c.conname FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = $3
     LIMIT 1`,
    [schema, table, contype],
  );
  return rows[0]?.conname ?? null;
}
