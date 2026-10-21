import { quoteIdentifier } from "./pg-dialect.js";
import type { ResolvedResource, SchemaContext } from "./schema-context.js";

export interface JoinSpec {
  alias: string;
  sql: string;
}

/** Allocates table aliases and LEFT JOIN clauses for one compiled query, reusing them across paths that share a prefix. */
export class JoinRegistry {
  readonly rootAlias = "t0";
  private counter = 0;
  private readonly byPrefix = new Map<string, { alias: string; resource: ResolvedResource }>();
  readonly joins: JoinSpec[] = [];

  nextAlias(): string {
    this.counter += 1;
    return `t${this.counter}`;
  }

  register(prefixKey: string, alias: string, resource: ResolvedResource, sql: string): void {
    this.byPrefix.set(prefixKey, { alias, resource });
    this.joins.push({ alias, sql });
  }

  get(prefixKey: string): { alias: string; resource: ResolvedResource } | undefined {
    return this.byPrefix.get(prefixKey);
  }
}

export interface ResolvedPath {
  tableAlias: string;
  columnName: string;
  columnSql: string;
  resource: ResolvedResource;
}

/**
 * Resolves a dotted field path into a table alias + column, creating
 * (or reusing) LEFT JOINs for each relation hop. See
 * Data_API.md §3.4.
 */
export async function resolvePath(
  schemaContext: SchemaContext,
  registry: JoinRegistry,
  root: ResolvedResource,
  path: string[],
): Promise<ResolvedPath> {
  let currentResource = root;
  let currentAlias = registry.rootAlias;
  let prefixKey = "";

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    prefixKey = prefixKey ? `${prefixKey}.${segment}` : segment;

    const existing = registry.get(prefixKey);
    if (existing) {
      currentResource = existing.resource;
      currentAlias = existing.alias;
      continue;
    }

    const relation = schemaContext.findRelation(currentResource, segment);
    const target = await schemaContext.resolveRelated(relation.targetSchema, relation.targetTable);
    const alias = registry.nextAlias();

    const sql =
      `LEFT JOIN ${quoteIdentifier(relation.targetSchema)}.${quoteIdentifier(relation.targetTable)} AS ${alias} ` +
      `ON ${alias}.${quoteIdentifier(relation.targetColumn)} = ${currentAlias}.${quoteIdentifier(segment)}`;
    registry.register(prefixKey, alias, target, sql);

    currentResource = target;
    currentAlias = alias;
  }

  const columnName = path[path.length - 1]!;
  const column = schemaContext.findColumn(currentResource, columnName);

  return {
    tableAlias: currentAlias,
    columnName,
    columnSql: `${currentAlias}.${quoteIdentifier(columnName)}`,
    resource: currentResource,
  };
}
