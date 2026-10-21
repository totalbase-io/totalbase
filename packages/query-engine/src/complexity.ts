import { TotalBaseError } from "@totalbase/errors";
import type { FilterNode, QueryAST } from "./ast.js";

/** Relation traversal hops implied by a dotted path (0 for a direct column). */
function relationHops(path: string[]): number {
  return Math.max(path.length - 1, 0);
}

export function countFilterNodes(node: FilterNode | undefined): number {
  if (!node) return 0;
  if (node.type === "comparison") return 1 + relationHops(node.path);
  return 1 + node.children.reduce((sum, child) => sum + countFilterNodes(child), 0);
}

/**
 * Structural complexity of a parsed query, per Data_API.md §12:
 * "must count structural query complexity, including at
 * minimum: comparison nodes; logical nodes; relation traversal nodes;
 * aggregate nodes; group fields; order fields."
 */
export function countQueryNodes(ast: QueryAST): number {
  let count = 0;
  count += countFilterNodes(ast.where);
  count += countFilterNodes(ast.having);
  for (const flag of ast.flags ?? []) count += 1 + countFilterNodes(flag.filter);
  for (const field of ast.fields ?? []) count += 1 + relationHops(field.path);
  for (const path of ast.searchFields ?? []) count += 1 + relationHops(path);
  for (const order of ast.orderBy ?? []) count += 1 + relationHops(order.path);
  for (const group of ast.groupBy ?? []) count += 1 + relationHops(group);
  for (const aggregate of ast.aggregates ?? []) {
    count += 1 + (aggregate.path === "*" ? 0 : relationHops(aggregate.path));
  }
  return count;
}

/**
 * `api.max_query_nodes` for a request filter parsed on its own - a write's
 * `where` (collection UPDATE/DELETE), which parseQuery() never sees. The same
 * count and error as a read (Data_API.md §12).
 */
export function assertFilterComplexity(node: FilterNode | undefined, maxQueryNodes: number): void {
  if (countFilterNodes(node) > maxQueryNodes) {
    throw new TotalBaseError("QUERY_COMPLEXITY_LIMIT_EXCEEDED", "Query exceeds the configured structural complexity limit.");
  }
}
