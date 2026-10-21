import type { AggregateFunction, ComparisonOperator } from "./operators.js";
import type { QueryVariable } from "./variables.js";

/** A raw (unresolved) leaf value: literal text from the query string, or a $variable. */
export type RawValue = string | QueryVariable;

export interface FieldNode {
  /** Dotted path split into segments, e.g. ["brand", "name"]. */
  path: string[];
  /** Output alias from fields[path]=alias; the path itself is never altered by it. */
  alias?: string | undefined;
}

export interface ComparisonNode {
  type: "comparison";
  path: string[];
  operator: ComparisonOperator;
  value: RawValue | RawValue[] | undefined;
}

export interface LogicalNode {
  type: "and" | "or" | "not";
  children: FilterNode[];
}

export type FilterNode = ComparisonNode | LogicalNode;

export interface AggregateNode {
  fn: AggregateFunction;
  /** Target path, or "*" for _count[*]. */
  path: string[] | "*";
  alias: string;
}

export interface OrderNode {
  /** Column path, or an aggregate alias. */
  path: string[];
  direction: "ASC" | "DESC";
}

export interface QueryAST {
  fields: FieldNode[] | undefined;
  where: FilterNode | undefined;
  search: string | undefined;
  /** `search_fields=a,b.c` (Data_API.md §3.5): the fields `search` looks in, a subset of what it would otherwise. */
  searchFields?: string[][] | undefined;
  groupBy: string[][] | undefined;
  having: FilterNode | undefined;
  orderBy: OrderNode[] | undefined;
  aggregates: AggregateNode[] | undefined;
  limit: number | undefined;
  offset: number | undefined;
  count: boolean;
  /** `flags[<name>]=<filter>` (Data_API.md §3.9): which of these each row meets - answered in `meta.flags`. */
  flags?: FlagNode[] | undefined;
}

/** A named filter a row is checked against - never a filter on which rows come back. */
export interface FlagNode {
  name: string;
  filter: FilterNode;
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  countSql: string | undefined;
  countParams: unknown[] | undefined;
}
