import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { quoteIdentifier, validateIdentifier, validateSqlExpression } from "./validation.js";

const INDEX_METHODS = ["btree", "hash", "gist", "gin", "spgist", "brin"] as const;
export type IndexMethod = (typeof INDEX_METHODS)[number];

export function validateIndexMethod(method: string): IndexMethod {
  if (!INDEX_METHODS.includes(method as IndexMethod)) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `Unsupported index method: ${method}`);
  }
  return method as IndexMethod;
}

/** A plain column name sorts ascending (Postgres's own default); pass an object to request DESC. */
export interface IndexColumnInput {
  name: string;
  direction?: "asc" | "desc" | undefined;
}

export interface CreateIndexInput {
  schema: string;
  table: string;
  name?: string | undefined;
  columns: (string | IndexColumnInput)[];
  method?: IndexMethod | undefined;
  unique?: boolean | undefined;
  /** Raw boolean expression - a partial index (Specification_Administration.md §3.10 leaves this to SQL Console for v1; the visual builder here covers it directly instead). */
  where?: string | undefined;
  /**
   * CONCURRENTLY avoids locking the table for writes, at the cost of
   * PostgreSQL forbidding it inside a transaction block - the caller
   * (not this builder) is responsible for running a CONCURRENTLY
   * statement outside any `BEGIN` it might otherwise batch other DDL
   * into. See AGENTS.md's Edit Table notes.
   */
  concurrently?: boolean | undefined;
}

export interface IndexSummary {
  name: string;
  /** Reconstructed via pg_get_indexdef() - the read-only "show DDL" view, same convention as View/Function. */
  definition: string;
  isUnique: boolean;
  isPrimary: boolean;
}

function qualified(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function buildCreateIndexSql(input: CreateIndexInput): string {
  validateIdentifier(input.schema, "schema");
  validateIdentifier(input.table, "table");
  if (input.columns.length === 0) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", "An index needs at least one column.");
  }
  const columnsSql = input.columns.map((c) => {
    const col = typeof c === "string" ? { name: c } : c;
    validateIdentifier(col.name, "column");
    return col.direction === "desc" ? `${quoteIdentifier(col.name)} DESC` : quoteIdentifier(col.name);
  });
  const method = input.method ? validateIndexMethod(input.method) : undefined;
  const name = input.name ? (validateIdentifier(input.name, "index"), quoteIdentifier(input.name)) : "";

  let sql = "CREATE ";
  if (input.unique) sql += "UNIQUE ";
  sql += "INDEX ";
  if (input.concurrently) sql += "CONCURRENTLY ";
  if (name) sql += `${name} `;
  sql += `ON ${qualified(input.schema, input.table)} `;
  if (method) sql += `USING ${method} `;
  sql += `(${columnsSql.join(", ")})`;
  if (input.where) {
    validateSqlExpression(input.where, "WHERE");
    sql += ` WHERE ${input.where}`;
  }
  return sql;
}

export function buildDropIndexSql(schema: string, name: string, concurrently = false): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(name, "index");
  return `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}${qualified(schema, name)}`;
}

/**
 * V1's index management (Specification_Administration.md §3.10) is spec'd as
 * introspect/list/show-DDL only, deliberately leaving creation to SQL
 * Console - deviated from here after review: since the Edit Table
 * drawer already builds structured DDL for everything else a table can
 * need, a visual index builder covering method/WHERE/CONCURRENTLY closes
 * the one remaining gap that would otherwise send an admin to SQL
 * Console anyway. Read/introspection is unaffected by that call.
 */
export class IndexService {
  constructor(private readonly database: Database) {}

  /** A table's indexes. The table itself must exist (a relation with indexes: table, partitioned table or materialized view) - RESOURCE_NOT_FOUND otherwise. */
  async list(schema: string, table: string): Promise<IndexSummary[]> {
    validateIdentifier(schema, "schema");
    validateIdentifier(table, "table");
    const { rows } = await this.database.query<{ name: string | null, definition: string | null, is_unique: boolean | null, is_primary: boolean | null }>(
      `SELECT
         ic.relname AS name,
         pg_get_indexdef(ix.indexrelid) AS definition,
         ix.indisunique AS is_unique,
         ix.indisprimary AS is_primary
       FROM pg_class tc
       JOIN pg_namespace n ON n.oid = tc.relnamespace
       LEFT JOIN pg_index ix ON ix.indrelid = tc.oid
       LEFT JOIN pg_class ic ON ic.oid = ix.indexrelid
       WHERE n.nspname = $1 AND tc.relname = $2 AND tc.relkind IN ('r', 'p', 'm')
       ORDER BY ic.relname`,
      [schema, table],
    );
    if (rows.length === 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Table not found: ${schema}.${table}`);
    return rows
      .filter((r) => r.name !== null)
      .map((r) => ({ name: r.name!, definition: r.definition!, isUnique: r.is_unique!, isPrimary: r.is_primary! }));
  }

  async create(input: CreateIndexInput): Promise<void> {
    // CONCURRENTLY can't run inside this.database.query() if that
    // connection happens to be mid-transaction - callers batching this
    // alongside other DDL must run it outside their transaction().
    await this.database.query(buildCreateIndexSql(input));
  }

  async drop(schema: string, name: string, concurrently = false): Promise<void> {
    await this.database.query(buildDropIndexSql(schema, name, concurrently));
  }
}
