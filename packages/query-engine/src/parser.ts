import { TotalBaseError } from "@totalbase/errors";
import type {
  AggregateNode,
  ComparisonNode,
  FieldNode,
  FilterNode,
  LogicalNode,
  OrderNode,
  QueryAST,
  RawValue,
  FlagNode,
} from "./ast.js";
import {
  AGGREGATE_FUNCTIONS,
  isComparisonOperator,
  isLogicalOperator,
  UNARY_OPERATORS,
  type AggregateFunction,
} from "./operators.js";
import { parseVariable } from "./variables.js";
import { countQueryNodes } from "./complexity.js";

export interface ParserLimits {
  maxFilterDepth: number;
  maxRelationDepth: number;
  /** Optional: when given, parseQuery() rejects a query whose total node count exceeds it (Specification_Data_API.md §12). parseFilter() alone doesn't count - a write's `where` goes through assertFilterComplexity(). */
  maxQueryNodes?: number | undefined;
}

/**
 * Parses an already bracket-decoded query object (e.g. from `qs.parse`)
 * into a QueryAST. See Specification_Data_API.md §3.1, §3.10.
 *
 * This stage only validates structure (known operators, depth limits,
 * path syntax); catalog-driven validation (field existence, types,
 * relations) happens in the compiler.
 */
export function parseQuery(raw: Record<string, unknown>, limits: ParserLimits): QueryAST {
  const ast: QueryAST = {
    fields: parseFields(raw["fields"], limits),
    where: raw["where"] !== undefined ? parseFilter(raw["where"], limits, 0) : undefined,
    search: parseSearch(raw["search"]),
    searchFields: parseSearchFields(raw["search_fields"], limits),
    groupBy: parseGroupBy(raw["group_by"], limits),
    having: raw["having"] !== undefined ? parseFilter(raw["having"], limits, 0) : undefined,
    orderBy: parseOrderBy(raw["order_by"], limits),
    aggregates: parseAggregates(raw, limits),
    limit: parseIntParam(raw["limit"], "limit"),
    offset: parseIntParam(raw["offset"], "offset"),
    count: raw["count"] === "true" || raw["count"] === true,
    flags: parseFlags(raw["flags"], limits),
  };

  if (limits.maxQueryNodes !== undefined && countQueryNodes(ast) > limits.maxQueryNodes) {
    throw new TotalBaseError("QUERY_COMPLEXITY_LIMIT_EXCEEDED", "Query exceeds the configured structural complexity limit.");
  }

  return ast;
}

/** At most this many flags in one request - each is one more column the rows are read with. */
export const MAX_FLAGS = 32;
const FLAG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** `flags[<name>]=<filter>` - each a name (an identifier) and a filter in the `where` grammar. */
function parseFlags(value: unknown, limits: ParserLimits): FlagNode[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TotalBaseError("INVALID_QUERY", "flags is an object: flags[<name>]=<filter>.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FLAGS) throw new TotalBaseError("QUERY_COMPLEXITY_LIMIT_EXCEEDED", `At most ${MAX_FLAGS} flags in one request.`);
  return entries.map(([name, filter]) => {
    if (!FLAG_NAME.test(name)) throw new TotalBaseError("INVALID_QUERY", `Invalid flag name: ${name} - letters, digits and _, not starting with a digit.`);
    return { name, filter: parseFilter(filter, limits, 0) };
  });
}

function splitPath(path: string, limits: ParserLimits): string[] {
  const segments = path.split(".");
  if (segments.some((s) => s.length === 0)) {
    throw new TotalBaseError("INVALID_FIELD", `Invalid field path: ${path}`);
  }
  if (segments.length - 1 > limits.maxRelationDepth) {
    throw new TotalBaseError(
      "QUERY_DEPTH_LIMIT_EXCEEDED",
      `Field path exceeds the maximum relation depth: ${path}`,
    );
  }
  return segments;
}

function parseFields(value: unknown, limits: ParserLimits): FieldNode[] | undefined {
  if (value === undefined) return undefined;

  // fields=a,b,c -> plain list, no aliases.
  if (typeof value === "string") {
    return value
      .split(",")
      .filter((s) => s.length > 0)
      .map((path) => ({ path: splitPath(path, limits) }));
  }

  // fields[a]=AliasA&fields[b]=AliasB -> selection with aliases.
  // (See packages/query-engine README-level note: the plain-list and
  // aliased-object forms are treated as alternatives, not merged, since
  // the spec never shows them combined in one request.)
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    const seenAliases = new Set<string>();
    return entries.map(([path, alias]) => {
      if (typeof alias !== "string") {
        throw new TotalBaseError("INVALID_ALIAS", `Invalid alias for field: ${path}`);
      }
      if (seenAliases.has(alias)) {
        throw new TotalBaseError("INVALID_ALIAS", `Duplicate alias: ${alias}`);
      }
      seenAliases.add(alias);
      return { path: splitPath(path, limits), alias };
    });
  }

  throw new TotalBaseError("INVALID_QUERY", "Invalid fields parameter.");
}

function parseSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TotalBaseError("INVALID_QUERY", "Invalid search parameter.");
  }
  return value;
}

/** `search_fields=name,brand.name` - the paths `search` looks in (Specification_Data_API.md §3.5). */
function parseSearchFields(value: unknown, limits: ParserLimits): string[][] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TotalBaseError("INVALID_QUERY", "Invalid search_fields parameter.");
  }
  const paths = value.split(",").filter((s) => s.length > 0).map((path) => splitPath(path, limits));
  if (paths.length === 0) {
    throw new TotalBaseError("INVALID_QUERY", "Invalid search_fields parameter.");
  }
  return paths;
}

function parseGroupBy(value: unknown, limits: ParserLimits): string[][] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TotalBaseError("INVALID_GROUP_BY", "Invalid group_by parameter.");
  }
  return value
    .split(",")
    .filter((s) => s.length > 0)
    .map((path) => splitPath(path, limits));
}

function parseOrderBy(value: unknown, limits: ParserLimits): OrderNode[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TotalBaseError("INVALID_QUERY", "Invalid order_by parameter.");
  }
  return value
    .split(",")
    .filter((s) => s.length > 0)
    .map((entry) => {
      const desc = entry.startsWith("-");
      const path = desc ? entry.slice(1) : entry;
      return { path: splitPath(path, limits), direction: desc ? "DESC" : ("ASC" as const) };
    });
}

function parseAggregates(raw: Record<string, unknown>, limits: ParserLimits): AggregateNode[] | undefined {
  const nodes: AggregateNode[] = [];

  for (const fn of AGGREGATE_FUNCTIONS) {
    const value = raw[fn];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null) {
      throw new TotalBaseError("INVALID_QUERY", `Invalid ${fn} parameter.`);
    }
    for (const [target, alias] of Object.entries(value as Record<string, unknown>)) {
      if (typeof alias !== "string" || alias.length === 0) {
        throw new TotalBaseError("INVALID_ALIAS", `${fn} requires an output alias for ${target}.`);
      }
      nodes.push({
        fn: fn as AggregateFunction,
        // A relation path is bounded like any other (api.max_relation_depth).
        path: target === "*" ? "*" : splitPath(target, limits),
        alias,
      });
    }
  }

  return nodes.length > 0 ? nodes : undefined;
}

function parseIntParam(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  // Text from a query string; a JSON integer from a query object written as JSON (a workflow's Read records step).
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" && Number.isInteger(value) ? value : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TotalBaseError("INVALID_QUERY", `Invalid ${name} parameter.`);
  }
  return parsed;
}

/** Exported for reuse compiling totalbase.permissions.where_clause (same filter grammar as `where`/`having`). */
export function parseFilter(value: unknown, limits: ParserLimits, depth: number): FilterNode {
  if (depth > limits.maxFilterDepth) {
    throw new TotalBaseError("QUERY_DEPTH_LIMIT_EXCEEDED", "Filter nesting exceeds the configured limit.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TotalBaseError("INVALID_QUERY", "Invalid filter object.");
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const children: FilterNode[] = [];

  for (const [key, subValue] of entries) {
    if (isLogicalOperator(key)) {
      children.push(parseLogicalGroup(key, subValue, limits, depth));
      continue;
    }
    // key is a field path; subValue is { _op: value, ... }
    children.push(...parseComparisons(key, subValue, limits));
  }

  if (children.length === 1) return children[0]!;
  return { type: "and", children };
}

function parseLogicalGroup(
  key: "_and" | "_or" | "_not",
  subValue: unknown,
  limits: ParserLimits,
  depth: number,
): LogicalNode {
  const type = key === "_and" ? "and" : key === "_or" ? "or" : "not";

  if (Array.isArray(subValue)) {
    return { type, children: subValue.map((v) => parseFilter(v, limits, depth + 1)) };
  }
  // _not may be given as a single object rather than an array.
  return { type, children: [parseFilter(subValue, limits, depth + 1)] };
}

function parseComparisons(path: string, subValue: unknown, limits: ParserLimits): ComparisonNode[] {
  if (typeof subValue !== "object" || subValue === null) {
    throw new TotalBaseError("INVALID_QUERY", `Invalid filter for field: ${path}`);
  }

  const segments = splitPath(path, limits);
  const nodes: ComparisonNode[] = [];

  for (const [operator, rawValue] of Object.entries(subValue as Record<string, unknown>)) {
    if (!isComparisonOperator(operator)) {
      throw new TotalBaseError("INVALID_OPERATOR", `Unknown operator: ${operator}`);
    }

    if (UNARY_OPERATORS.has(operator)) {
      nodes.push({ type: "comparison", path: segments, operator, value: undefined });
      continue;
    }

    nodes.push({
      type: "comparison",
      path: segments,
      operator,
      value: parseValue(operator, rawValue),
    });
  }

  return nodes;
}

function parseValue(operator: string, rawValue: unknown): RawValue | RawValue[] {
  const listOperator = operator === "_in" || operator === "_nin" || operator === "_between";
  // A list as a list - JSON in a stored filter, or a repeated query parameter (`_in[]=a&_in[]=b`) -
  // so a value may hold a comma; a string is still split on commas.
  if (Array.isArray(rawValue)) {
    if (!listOperator) throw new TotalBaseError("INVALID_QUERY", `Invalid value for operator ${operator}: a list is only for _in, _nin and _between.`);
    const items = rawValue.map((item) => {
      const text = scalarText(item);
      if (text === undefined) throw new TotalBaseError("INVALID_QUERY", `Invalid value for operator ${operator}: a list holds strings, numbers or booleans.`);
      return text;
    });
    return listValues(operator, items);
  }
  // A JSON number or boolean is its text: PostgreSQL casts it like the query string's "20" or "true".
  const text = scalarText(rawValue);
  if (text === undefined) {
    throw new TotalBaseError("INVALID_QUERY", `Invalid value for operator ${operator}.`);
  }
  return listOperator ? listValues(operator, text.split(",")) : toRawValue(text);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") return String(value);
  return undefined;
}

function listValues(operator: string, items: string[]): RawValue[] {
  if (operator === "_between" && items.length !== 2) {
    throw new TotalBaseError("INVALID_QUERY", "_between requires exactly two values.");
  }
  if (items.length === 0) {
    throw new TotalBaseError("INVALID_QUERY", `${operator} requires at least one value.`);
  }
  return items.map(toRawValue);
}

function toRawValue(raw: string): RawValue {
  const variable = parseVariable(raw);
  return variable ?? raw;
}
