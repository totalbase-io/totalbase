import type { ColumnDefinition, RelationDefinition } from "@totalbase/pg-catalog";
import { getChildForeignKeys, getRelationDetail } from "@totalbase/pg-catalog";
import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/** A resolved nested-write child relation: the child resource plus which of its columns carries the FK back to the parent. */
export interface ResolvedNestedChild {
  resource: ResolvedResource;
  resourceId: string;
  /** FK column on the CHILD, e.g. "invoice" in invoice_items.invoice -> invoices.id. */
  fkColumn: string;
  /** Column on the PARENT the FK targets, e.g. "id" - read this off the parent's persisted row to get the value to propagate. */
  parentColumn: string;
}

export interface ResolvedResource {
  oid: number;
  schema: string;
  table: string;
  columns: ColumnDefinition[];
  primaryKey: string[];
  relations: RelationDefinition[];
  uniqueConstraints: string[][];
}

/**
 * Loads and caches column/relation metadata for the root resource and
 * any related tables reached through relation traversal (Data_API.md §3.4).
 *
 * Only tables that are ACTIVE, EXPOSED TotalBase resources may be
 * traversed into - this keeps hidden/internal tables from leaking
 * through a relation path even if a real FK exists.
 */
export class SchemaContext {
  private readonly cache = new Map<string, ResolvedResource>();

  constructor(private readonly database: Database) {}

  async loadRoot(schema: string, table: string, oid: number): Promise<ResolvedResource> {
    const detail = await getRelationDetail(this.database, oid);
    const resource: ResolvedResource = { oid, schema, table, ...detail };
    this.cache.set(`${schema}.${table}`, resource);
    return resource;
  }

  /** Resolves a relation target, requiring it to be an ACTIVE, exposed resource with GET mounted (embedding is a read, same ceiling as fetching the table directly). */
  async resolveRelated(schema: string, table: string): Promise<ResolvedResource> {
    const key = `${schema}.${table}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    // (schema, name) has no unique constraint - only postgres_oid does
    // - so a dropped-and-recreated table can leave
    // several rows sharing this name behind: the old one, kept forever
    // as `status = 'MISSING'` (reconcile-resources.ts never deletes
    // those), and the new one, `ACTIVE`. With no ORDER BY, Postgres's
    // row order here is unspecified - this used to just take `rows[0]`
    // and could hand back the stale MISSING row instead of the real
    // ACTIVE one, failing a perfectly-exposed FK target with "Relation
    // target is not available". Ordering ACTIVE first, then most
    // recently updated, makes the intended row win deterministically.
    const { rows } = await this.database.query<{ id: string; postgres_oid: number; status: string; exposed_methods: string[] }>(
      `SELECT id, postgres_oid, status, exposed_methods FROM totalbase.resources
       WHERE "schema" = $1 AND name = $2
       ORDER BY (status = 'ACTIVE') DESC, updated_at DESC
       LIMIT 1`,
      [schema, table],
    );
    const row = rows[0];
    if (!row || row.status !== "ACTIVE" || !row.exposed_methods.includes("GET")) {
      throw new TotalBaseError("INVALID_RELATION", `Relation target is not available: ${schema}.${table}`);
    }

    const detail = await getRelationDetail(this.database, row.postgres_oid);
    const resource: ResolvedResource = { oid: row.postgres_oid, schema, table, ...detail };
    this.cache.set(key, resource);
    return resource;
  }

  /**
   * Resolves a nested-write relation property (e.g. "$invoice_items" while
   * processing "invoices") to a real child resource and its FK column.
   * See Data_API.md §6.2.
   *
   * - The child table must exist in the SAME schema as the parent, be an
   *   ACTIVE resource, and have `method` mounted (its "create" ceiling).
   * - Exactly one single-column FK from the child to the parent must
   *   exist; zero -> INVALID_NESTED_RELATION, more than one ->
   *   AMBIGUOUS_NESTED_RELATION.
   */
  async resolveNestedChild(
    parent: ResolvedResource,
    childTable: string,
    method: "POST" | "PATCH",
  ): Promise<ResolvedNestedChild> {
    const { rows } = await this.database.query<{
      id: string;
      postgres_oid: number;
      status: string;
      exposed_methods: string[];
    }>(
      `SELECT id, postgres_oid, status, exposed_methods FROM totalbase.resources WHERE "schema" = $1 AND name = $2`,
      [parent.schema, childTable],
    );
    const row = rows[0];
    if (!row || row.status !== "ACTIVE" || !row.exposed_methods.includes(method)) {
      throw new TotalBaseError(
        "INVALID_NESTED_RELATION",
        `Nested relation target is not available: ${parent.schema}.${childTable}`,
      );
    }

    const childRelations = await getChildForeignKeys(this.database, parent.oid);
    const matches = childRelations.filter((r) => r.childSchema === parent.schema && r.childTable === childTable);
    if (matches.length === 0) {
      throw new TotalBaseError(
        "INVALID_NESTED_RELATION",
        `No foreign key found from ${parent.schema}.${childTable} to ${parent.schema}.${parent.table}`,
      );
    }
    if (matches.length > 1) {
      throw new TotalBaseError(
        "AMBIGUOUS_NESTED_RELATION",
        `Multiple foreign keys from ${parent.schema}.${childTable} to ${parent.schema}.${parent.table}; nested writes require exactly one.`,
      );
    }
    const fk = matches[0]!;

    const resource = await this.resolveRelatedForWrite(parent.schema, childTable, row.postgres_oid);
    return { resource, resourceId: row.id, fkColumn: fk.childColumn, parentColumn: fk.parentColumn };
  }

  /** Like resolveRelated, but does not require GET to be mounted - write-side callers already checked the `method` ceiling themselves. */
  private async resolveRelatedForWrite(schema: string, table: string, oid: number): Promise<ResolvedResource> {
    const key = `${schema}.${table}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const detail = await getRelationDetail(this.database, oid);
    const resource: ResolvedResource = { oid, schema, table, ...detail };
    this.cache.set(key, resource);
    return resource;
  }

  findColumn(resource: ResolvedResource, name: string): ColumnDefinition {
    const column = resource.columns.find((c) => c.name === name);
    if (!column) {
      throw new TotalBaseError("INVALID_FIELD", `Unknown field: ${resource.table}.${name}`);
    }
    return column;
  }

  findRelation(resource: ResolvedResource, sourceColumn: string): RelationDefinition {
    const relation = resource.relations.find((r) => r.sourceColumn === sourceColumn);
    if (!relation) {
      throw new TotalBaseError(
        "INVALID_RELATION",
        `No foreign key found for ${resource.table}.${sourceColumn}`,
      );
    }
    return relation;
  }
}

/** A write's relation resolver over `schemaContext` (MutationCompileContext.related) - reads resolve relations the same way. */
export function relatedResolver(schemaContext: SchemaContext): (schema: string, table: string) => Promise<ResolvedResource> {
  return (schema, table) => schemaContext.resolveRelated(schema, table);
}
