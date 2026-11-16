/**
 * The Query Language's operator names (Data_API.md §3.3) - the neutral wire contract, which names the API accepts.
 * The query engine parses and compiles them; the admin's condition builder offers them. Their SQL is the engine's.
 */
export const COMPARISON_OPERATORS = [
  "_eq",
  "_neq",
  "_gt",
  "_gte",
  "_lt",
  "_lte",
  "_like",
  "_ilike",
  "_regex",
  "_in",
  "_nin",
  "_between",
  "_null",
  "_nnull",
  "_contains",
  "_contained_by",
  "_overlap",
] as const;

export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export const LOGICAL_OPERATORS = ["_and", "_or", "_not"] as const;
export type LogicalOperator = (typeof LOGICAL_OPERATORS)[number];

export const AGGREGATE_FUNCTIONS = ["_sum", "_count", "_avg", "_min", "_max"] as const;
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];

export function isComparisonOperator(value: string): value is ComparisonOperator {
  return (COMPARISON_OPERATORS as readonly string[]).includes(value);
}

export function isLogicalOperator(value: string): value is LogicalOperator {
  return (LOGICAL_OPERATORS as readonly string[]).includes(value);
}

/** Operators that take no value (unary). */
export const UNARY_OPERATORS: ReadonlySet<ComparisonOperator> = new Set(["_null", "_nnull"]);
