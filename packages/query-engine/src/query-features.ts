import { TotalBaseError } from "@totalbase/errors";
import type { FilterNode, QueryAST } from "./ast.js";
import type { ComparisonOperator } from "./operators.js";

/**
 * Query language features an instance can switch off for Data API callers
 * (Data_API.md §3.12: api.allow_count, query.allow_regex/_contains/_having) -
 * typically the ones that can get expensive on large tables without the
 * right index. Applies only to what a caller sends; row filters, payload
 * checks and workflow steps are written by an admin and stay unrestricted.
 */
export interface QueryFeatures {
  count: boolean;
  regex: boolean;
  /** `_contains`, `_contained_by` and `_overlap` - array/jsonb containment. */
  contains: boolean;
  having: boolean;
}

const CONTAINMENT: ReadonlySet<ComparisonOperator> = new Set(["_contains", "_contained_by", "_overlap"]);

function disabled(feature: string, setting: string): TotalBaseError {
  return new TotalBaseError("QUERY_FEATURE_DISABLED", `${feature} is turned off on this instance (${setting}).`);
}

/** Rejects a filter that uses an operator switched off in `features`. */
export function assertFilterFeatures(filter: FilterNode | undefined, features: QueryFeatures): void {
  if (!filter) return;
  if (filter.type !== "comparison") {
    for (const child of filter.children) assertFilterFeatures(child, features);
    return;
  }
  if (filter.operator === "_regex" && !features.regex) throw disabled("The _regex operator", "query.allow_regex");
  if (CONTAINMENT.has(filter.operator) && !features.contains) {
    throw disabled(`The ${filter.operator} operator`, "query.allow_contains");
  }
}

/** Rejects a parsed read query that uses a feature switched off in `features`. */
export function assertQueryFeatures(ast: QueryAST, features: QueryFeatures): void {
  if (ast.count && !features.count) throw disabled("count", "api.allow_count");
  if (ast.having && !features.having) throw disabled("having", "query.allow_having");
  assertFilterFeatures(ast.where, features);
  assertFilterFeatures(ast.having, features);
}
