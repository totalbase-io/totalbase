import { TotalBaseError } from "@totalbase/errors";
import type { ResolvedResource } from "./schema-context.js";
import { quoteIdentifier, qualifiedTable } from "./pg-dialect.js";
import { coerceLiteral } from "./value-coercion.js";
import type { FilterCompileContext } from "./filter-compiler.js";

/** A relation target as reads resolve it (SchemaContext.resolveRelated): an ACTIVE, exposed resource only. */
export type RelatedResolver = (schema: string, table: string) => Promise<ResolvedResource>;

let relationAliasCounter = 0;

/**
 * A FilterCompileContext for a write: the target table's own columns, and - with `related` - a relation path
 * (`technician.user`) as a scalar subquery that follows the foreign keys from the row being written
 * (Security.md §6.5): `(SELECT r2."user" FROM "public"."technicians" AS r1 … WHERE r1."id" = upd."technician")`.
 * Each step is a foreign key to a unique column, so it yields one value or none - NULL, as a read's LEFT JOIN does,
 * and a comparison with it is never true. Only the grant's own filters and payload checks get `related`: a request's
 * `where` on a write stays on the table's own columns.
 */
export function mutationFilterContext(
  resource: ResolvedResource,
  tableAlias: string,
  resolveUserVariable: (field: string) => unknown,
  related?: RelatedResolver,
): FilterCompileContext {
  return {
    async resolveColumn(path: string[]) {
      if (path.length === 1) {
        const column = resource.columns.find((c) => c.name === path[0]);
        if (!column) throw new TotalBaseError("INVALID_FIELD", `Unknown field: ${resource.table}.${path[0]}`);
        return { columnSql: `${tableAlias}.${quoteIdentifier(column.name)}`, dataType: column.dataType };
      }
      if (!related) throw new TotalBaseError("INVALID_RELATION", "Relation traversal is not supported in a write's where.");
      return relationSubquery(resource, tableAlias, path, related);
    },
    coerceLiteral,
    resolveUserVariable,
  };
}

async function relationSubquery(root: ResolvedResource, tableAlias: string, path: string[], related: RelatedResolver): Promise<{ columnSql: string; dataType: string }> {
  const prefix = `__rel${++relationAliasCounter}_`;
  let current = root;
  let from = "";
  let correlation = "";
  for (let i = 0; i < path.length - 1; i += 1) {
    const relation = current.relations.find((r) => r.sourceColumn === path[i]);
    if (!relation) throw new TotalBaseError("INVALID_RELATION", `No foreign key found for ${current.table}.${path[i]}`);
    const target = await related(relation.targetSchema, relation.targetTable);
    const alias = `${prefix}${i}`;
    const source = i === 0 ? tableAlias : `${prefix}${i - 1}`;
    const on = `${alias}.${quoteIdentifier(relation.targetColumn)} = ${source}.${quoteIdentifier(relation.sourceColumn)}`;
    if (i === 0) {
      from = `${qualifiedTable(target.schema, target.table)} AS ${alias}`;
      correlation = on;
    } else {
      from += ` JOIN ${qualifiedTable(target.schema, target.table)} AS ${alias} ON ${on}`;
    }
    current = target;
  }
  const last = path[path.length - 1]!;
  const column = current.columns.find((c) => c.name === last);
  if (!column) throw new TotalBaseError("INVALID_FIELD", `Unknown field: ${current.table}.${last}`);
  return {
    columnSql: `(SELECT ${prefix}${path.length - 2}.${quoteIdentifier(column.name)} FROM ${from} WHERE ${correlation})`,
    dataType: column.dataType,
  };
}
