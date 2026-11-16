// The operator names are the shared wire contract (@totalbase/shared, Data_API.md §3.3); the actual per-operator
// SQL (OPERATOR_SQL) is dialect-sensitive and lives in pg-dialect.ts.
export {
  AGGREGATE_FUNCTIONS,
  COMPARISON_OPERATORS,
  isComparisonOperator,
  isLogicalOperator,
  LOGICAL_OPERATORS,
  UNARY_OPERATORS,
  type AggregateFunction,
  type ComparisonOperator,
  type LogicalOperator,
} from "@totalbase/shared";
