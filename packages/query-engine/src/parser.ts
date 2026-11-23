import { TotalBaseError } from "@totalbase/errors";
import { searchTerms } from "./search-terms.js";
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
import { FilterLiteral } from "./ast.js";
import { countQueryNodes } from "./complexity.js";

export interface ParserLimits {
  maxFilterDepth: number;
  maxRelationDepth: number;
  /** Optional: when given, parseQuery() rejects a query whose total node count exceeds it (Data_API.md §12). parseFilter() alone doesn't count - a write's `where` goes through assertFilterComplexity(). */
  maxQueryNodes?: number | undefined;
}

/**
 * Parses an already bracket-decoded query object (e.g. from `qs.parse`)
 * into a QueryAST. See Data_API.md §3.1, §3.10.
 *
 * This stage only validates structure (known operators, depth limits,
 * path syntax); catalog-driven validation (field existence, types,
 * relations) happens in the compiler.
 */
export function parseQuery(raw: Record<string, unknown>, limits: ParserLimits): QueryAST {
  assertKnownParameters(raw);
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

/** A read's top-level parameters (Data_API.md §3.1) - the aggregates are AGGREGATE_FUNCTIONS. */
const QUERY_PARAMETERS: readonly string[] = ["fields", "where", "search", "search_fields", "group_by", "having", "order_by", "limit", "offset", "count", "flags", ...AGGREGATE_FUNCTIONS];
const KNOWN_PARAMETERS = new Set(QUERY_PARAMETERS);
/** What a parameter another API names means here - the refusal says so. */
const PARAMETER_HINTS: Record<string, string> = {
  sort: "order_by", order: "order_by", orderBy: "order_by", sort_by: "order_by",
  select: "fields", columns: "fields", filter: "where", q: "search",
  page: "offset", per_page: "limit", page_size: "limit", skip: "offset", take: "limit",
  aggregate: "_count, _sum, _avg, _min or _max", groupBy: "group_by", searchFields: "search_fields",
};

/**
 * A parameter the query language doesn't define is refused, never dropped: `sort=-amount` read unsorted, `aggregate`
 * read rows - a caller (an agent most of all) learned nothing. Data_API.md §3.1.
 */
function assertKnownParameters(raw: Record<string, unknown>): void {
  const unknown = Object.keys(raw).filter((key) => !KNOWN_PARAMETERS.has(key));
  if (unknown.length === 0) return;
  const hints = unknown.filter((key) => PARAMETER_HINTS[key]).map((key) => `${key} -> ${PARAMETER_HINTS[key]}`);
  throw new TotalBaseError(
    "INVALID_QUERY",
    `Unknown query parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}${hints.length > 0 ? ` (${hints.join("; ")})` : ""}. A read takes: ${QUERY_PARAMETERS.join(", ")}.`,
    { meta: { parameters: unknown } },
  );
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

  // fields=a&fields=b, or a list in a workflow step's query -> the same plain list (it was read as an alias map,
  // its indexes as columns: "Unknown field: casos.0").
  if (Array.isArray(value)) {
    if (!value.every((path) => typeof path === "string")) throw new TotalBaseError("INVALID_QUERY", "fields is a comma-separated text, a list of paths, or { path: alias }.");
    return parseFields((value as string[]).join(","), limits);
  }

  // fields[a]=AliasA&fields[b]=AliasB -> selection with aliases.
  // (See packages/query-engine README-level note: the plain-list and
  // aliased-object forms are treated as alternatives, not merged, since
  // the spec never shows them combined in one request.)
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    const seenAliases = new Set<string>();
    return entries.map(([path, alias]) => {
      if (typeof alias !== "string" || !isAliasText(alias)) {
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

/**
 * The most words a `search` takes (Data_API.md §3.5, §12): each is matched in every searched field, so thousands
 * of them compiled to hundreds of thousands of comparisons before any limit refused the request.
 */
export const MAX_SEARCH_TERMS = 10;

function parseSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TotalBaseError("INVALID_QUERY", "Invalid search parameter.");
  }
  if (searchTerms(value).length > MAX_SEARCH_TERMS) {
    throw new TotalBaseError("QUERY_COMPLEXITY_LIMIT_EXCEEDED", `search takes at most ${MAX_SEARCH_TERMS} words.`);
  }
  return value;
}


/** `search_fields=name,brand.name` - the paths `search` looks in (Data_API.md §3.5). */
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
      if (typeof alias !== "string" || alias.length === 0 || !isAliasText(alias)) {
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

/**
 * The most values one `_in`/`_nin` list holds (Data_API.md §12): each is a bind parameter, and a filter's node count
 * sees the list as one - a 5 MB body's two million values were parsed, bound, and re-read by every caller.
 */
export const MAX_LIST_VALUES = 10_000;

function assertListLength(operator: string, length: number): void {
  if (length > MAX_LIST_VALUES) {
    throw new TotalBaseError("QUERY_COMPLEXITY_LIMIT_EXCEEDED", `${operator} takes at most ${MAX_LIST_VALUES} values.`);
  }
}

function parseValue(operator: string, rawValue: unknown): RawValue | RawValue[] {
  const listOperator = operator === "_in" || operator === "_nin" || operator === "_between";
  // A program's value (FilterLiteral): that value as it is - never a variable, a string never split on commas.
  if (rawValue instanceof FilterLiteral) {
    if (Array.isArray(rawValue.value)) return parseValue(operator, rawValue.value.map((item) => new FilterLiteral(item)));
    const text = scalarText(rawValue.value);
    if (text === undefined) throw new TotalBaseError("INVALID_QUERY", `Invalid value for operator ${operator}.`);
    return listOperator ? listValues(operator, [text], true) : text;
  }
  // A list as a list - JSON in a stored filter, or a repeated query parameter (`_in[]=a&_in[]=b`) -
  // so a value may hold a comma; a string is still split on commas.
  if (Array.isArray(rawValue)) {
    if (!listOperator) throw new TotalBaseError("INVALID_QUERY", `Invalid value for operator ${operator}: a list is only for _in, _nin and _between.`);
    assertListLength(operator, rawValue.length);
    const items = rawValue.map((item) => {
      const literal = item instanceof FilterLiteral;
      const text = scalarText(literal ? item.value : item);
      if (text === undefined) throw new TotalBaseError("INVALID_QUERY", `Invalid value for operator ${operator}: a list holds strings, numbers or booleans.`);
      return { text, literal };
    });
    listValues(operator, items.map((item) => item.text), true);
    return items.map((item) => (item.literal ? item.text : toRawValue(item.text)));
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

function listValues(operator: string, items: string[], literal = false): RawValue[] {
  assertListLength(operator, items.length);
  if (operator === "_between" && items.length !== 2) {
    throw new TotalBaseError("INVALID_QUERY", "_between requires exactly two values.");
  }
  if (items.length === 0) {
    throw new TotalBaseError("INVALID_QUERY", `${operator} requires at least one value.`);
  }
  return literal ? items : items.map(toRawValue);
}

function toRawValue(raw: string): RawValue {
  const variable = parseVariable(raw);
  return variable ?? raw;
}

/** An output alias is a name: at most 63 characters (PostgreSQL's), no control characters - a NUL would end the SQL. */
function isAliasText(alias: string): boolean {
  return alias.length <= 63 && !/[\u0000-\u001F\u007F]/.test(alias);
}
