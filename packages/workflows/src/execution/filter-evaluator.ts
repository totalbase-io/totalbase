import { TotalBaseError } from "@totalbase/errors";
import type { ComparisonNode, FilterNode, QueryVariable } from "@totalbase/query-engine";

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

function likePatternToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "is" : "s");
}

function evaluateComparison(node: ComparisonNode, input: unknown): boolean {
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

  const target = coerce(resolveRawValue(node.value as string | QueryVariable, input), fieldValue);
  if (node.operator === "_like") return likePatternToRegExp(String(target), false).test(String(fieldValue ?? ""));
  if (node.operator === "_ilike") return likePatternToRegExp(String(target), true).test(String(fieldValue ?? ""));
  if (node.operator === "_regex") return new RegExp(String(target)).test(String(fieldValue ?? ""));

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
export function evaluateFilter(node: FilterNode, input: unknown): boolean {
  if (node.type === "and") return node.children.every((child) => evaluateFilter(child, input));
  if (node.type === "or") return node.children.some((child) => evaluateFilter(child, input));
  if (node.type === "not") return !node.children.every((child) => evaluateFilter(child, input));
  return evaluateComparison(node as ComparisonNode, input);
}
