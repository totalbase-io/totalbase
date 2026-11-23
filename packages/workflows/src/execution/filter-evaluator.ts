import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { ComparisonNode, FilterNode, QueryVariable } from "@totalbase/query-engine";

/** A pattern comparison's answer, computed by PostgreSQL before the rest of the filter is evaluated here. */
export type PatternMatches = ReadonlyMap<ComparisonNode, boolean>;

const PATTERN_OPERATORS: Record<string, string> = { _like: "LIKE", _ilike: "ILIKE", _regex: "~" };

/** How long PostgreSQL may take matching one filter's patterns - a pattern built to backtrack is cancelled, not waited for. */
const PATTERN_TIMEOUT_MS = 1_000;

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveRawValue(raw: string | QueryVariable, input: unknown): unknown {
  if (typeof raw === "string") return raw;
  switch (raw.kind) {
    // Another field of the same object - the row the filter reads (Data_API.md §3.7).
    case "row":
      return getPath(input, [raw.column]);
    case "currentTimestamp":
    case "currentTime":
      return new Date();
    case "currentDate":
      return new Date(new Date().toDateString());
    case "interval": {
      // CURRENT_TIMESTAMP - interval (Data_API.md §3.7): $INTERVAL.7d is 7 days ago.
      const msPerUnit: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
      return new Date(Date.now() - raw.amount * msPerUnit[raw.unit]!);
    }
    case "user":
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "$USER variables are not supported in workflow filters.");
    case "period":
      // Its bounds are computed by PostgreSQL in the session's time zone; a
      // filter evaluated here has no database to ask, and a second
      // computation in Node's time zone could disagree about where a day starts.
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "$PERIOD variables are not supported in workflow filters.");
  }
}

/** Coerces a raw (string/Date) comparison value toward the type of the field it's being compared against - there's no column type to coerce against here (unlike SQL compilation), just the shape of whatever the binding actually resolved to. */
function coerce(rawValue: unknown, sample: unknown): unknown {
  if (rawValue instanceof Date || typeof rawValue !== "string") return rawValue;
  if (typeof sample === "number") {
    const n = Number(rawValue);
    return Number.isNaN(n) ? rawValue : n;
  }
  if (typeof sample === "boolean") return rawValue === "true";
  if (sample instanceof Date) {
    const d = new Date(rawValue);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return rawValue;
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date || b instanceof Date) return new Date(a as Date | string | number).getTime() - new Date(b as Date | string | number).getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function evaluateComparison(node: ComparisonNode, input: unknown, patterns: PatternMatches): boolean {
  const fieldValue = getPath(input, node.path);
  if (node.operator === "_null") return fieldValue === null || fieldValue === undefined;
  if (node.operator === "_nnull") return fieldValue !== null && fieldValue !== undefined;
  if (node.value === undefined) return false;

  if (node.operator === "_in" || node.operator === "_nin") {
    const values = (node.value as (string | QueryVariable)[]).map((v) => coerce(resolveRawValue(v, input), fieldValue));
    const isIn = values.some((v) => compareValues(fieldValue, v) === 0);
    return node.operator === "_in" ? isIn : !isIn;
  }
  if (node.operator === "_between") {
    const [lo, hi] = (node.value as (string | QueryVariable)[]).map((v) => coerce(resolveRawValue(v, input), fieldValue));
    return compareValues(fieldValue, lo) >= 0 && compareValues(fieldValue, hi) <= 0;
  }
  if (node.operator === "_contains" || node.operator === "_contained_by" || node.operator === "_overlap") {
    const other = coerce(resolveRawValue(node.value as string | QueryVariable, input), fieldValue);
    const a = Array.isArray(fieldValue) ? fieldValue : [];
    const b = Array.isArray(other) ? other : [other];
    if (node.operator === "_contains") return b.every((v) => a.some((x) => compareValues(x, v) === 0));
    if (node.operator === "_contained_by") return a.every((v) => b.some((x) => compareValues(x, v) === 0));
    return a.some((v) => b.some((x) => compareValues(x, v) === 0));
  }

  if (node.operator in PATTERN_OPERATORS) {
    const matched = patterns.get(node);
    if (matched === undefined) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "A pattern comparison was not matched by PostgreSQL first (matchPatterns).");
    return matched;
  }
  const target = coerce(resolveRawValue(node.value as string | QueryVariable, input), fieldValue);

  const cmp = compareValues(fieldValue, target);
  switch (node.operator) {
    case "_eq": return cmp === 0;
    case "_neq": return cmp !== 0;
    case "_gt": return cmp > 0;
    case "_gte": return cmp >= 0;
    case "_lt": return cmp < 0;
    case "_lte": return cmp <= 0;
    default: return false;
  }
}

/**
 * Evaluates a FilterNode (from @totalbase/query-engine's parseFilter -
 * same grammar every filter in the app uses, AGENTS.md section 7 "one
 * grammar, three uses") against a plain in-memory JS value, instead of
 * compiling it to SQL. Condition/Validate-data's `filter`/`rules` test a
 * resolved binding (trigger data, or a literal) rather than a table row,
 * so there's no ResolvedResource for compileSelect to compile against -
 * this is a second, JS-side evaluator for the same AST, not a competing
 * filter language (spec: "no competing filter language").
 */
export function evaluateFilter(node: FilterNode, input: unknown, patterns: PatternMatches = new Map()): boolean {
  if (node.type === "and") return node.children.every((child) => evaluateFilter(child, input, patterns));
  if (node.type === "or") return node.children.some((child) => evaluateFilter(child, input, patterns));
  if (node.type === "not") return !node.children.every((child) => evaluateFilter(child, input, patterns));
  return evaluateComparison(node as ComparisonNode, input, patterns);
}

function patternNodes(node: FilterNode, into: ComparisonNode[] = []): ComparisonNode[] {
  if (node.type === "and" || node.type === "or" || node.type === "not") for (const child of node.children) patternNodes(child, into);
  else if ((node as ComparisonNode).operator in PATTERN_OPERATORS && (node as ComparisonNode).value !== undefined) into.push(node as ComparisonNode);
  return into;
}

/**
 * `_like`, `_ilike` and `_regex` are PostgreSQL's (Workflows.md §5.9): every one of a filter's, against `input`, in
 * one statement under a short statement_timeout - as the Data API matches them. A pattern can be a binding the
 * trigger chose, and a backtracking one evaluated here would hold the server's one thread; PostgreSQL's is
 * cancelled at the timeout (`WORKFLOW_LIMIT_EXCEEDED`). Same semantics as everywhere else: LIKE's, and POSIX
 * regular expressions.
 */
export async function matchPatterns(database: Pick<Database, "transaction">, node: FilterNode, input: unknown): Promise<PatternMatches> {
  const nodes = patternNodes(node);
  const matches = new Map<ComparisonNode, boolean>();
  if (nodes.length === 0) return matches;
  const params: string[] = [];
  const tests = nodes.map((comparison) => {
    params.push(String(getPath(input, comparison.path) ?? ""), String(resolveRawValue(comparison.value as string | QueryVariable, input)));
    return `$${params.length - 1}::text ${PATTERN_OPERATORS[comparison.operator]} $${params.length}::text`;
  });
  let rows: { r: boolean[] }[];
  try {
    ({ rows } = await database.transaction((client) => client.query<{ r: boolean[] }>(`SELECT ARRAY[${tests.join(", ")}] AS r`, params), { statementTimeoutMs: PATTERN_TIMEOUT_MS }));
  } catch (error) {
    if (error instanceof TotalBaseError && error.sqlstate === "57014") {
      throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `A pattern took longer than ${PATTERN_TIMEOUT_MS} ms to match - simplify it.`);
    }
    throw error;
  }
  nodes.forEach((comparison, index) => matches.set(comparison, rows[0]!.r[index] === true));
  return matches;
}
