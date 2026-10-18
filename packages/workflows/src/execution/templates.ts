import { TotalBaseError } from "@totalbase/errors";
import type { RunState } from "./bindings.js";

/**
 * `{{operation.data.field}}` template expressions (agreed with the user
 * over several rounds of design discussion, replacing the structured
 * `Binding` picker for create/update/delete records' `records`/`set`/
 * `where` fields specifically - see those handlers' own doc comments for
 * why only those three, not the whole catalog, in this pass).
 *
 * Chose `{{...}}` over `${...}` deliberately: it's the dominant convention
 * in the workflow-automation product category itself (n8n, Zapier, Make
 * all use it) - a user arriving from any of those tools already has the
 * muscle memory, which matters more here than matching `$USER.*`/
 * `$INTERVAL.*` (a sibling but separate convention, owned by
 * @totalbase/query-engine's filter grammar, deliberately left untouched -
 * that's a stable, spec-defined public contract, not something this
 * session's own "pre-release, nothing to preserve" reasoning applies to).
 *
 * Two resolution modes, chosen by shape, not by any explicit flag:
 * - A string that IS, in full (trimmed), exactly one `{{...}}` expression
 *   resolves to the REAL typed value (object/array/number/boolean survive
 *   intact) - this is what lets `"records": "{{start.data}}"` hand over a
 *   whole array, or a numeric field stay a number.
 * - A `{{...}}` embedded inside a longer string interpolates as text
 *   (the resolved value is stringified and spliced in) - same behavior
 *   every templating engine in this product category has.
 * Applied recursively through the whole JSON value (nested objects/arrays,
 * not just top-level fields) - a `{{...}}` can appear anywhere a JSON
 * string literal legally can.
 *
 * The first path segment is normally another operation's own `key`
 * ("start" included) - `resolveRoot()`'s own doc comment covers the one
 * exception, `item`, a reserved word resolving against the current For
 * each element / Process in batches chunk instead (replaces the old
 * `Binding`'s `source: "iteration"`, which had no `{{...}}` equivalent
 * until this round).
 */

const WHOLE_VALUE_PATTERN = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const EXPRESSION_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

interface PathSegment {
  key: string;
  index?: number;
}

/** Parses `foo.bar[0].baz` into ordered {key, index?} segments - the first segment is always the operation's own `key` ("start" included). */
function parsePath(expression: string): PathSegment[] {
  const trimmed = expression.trim();
  if (!trimmed) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "A {{...}} expression cannot be empty.");
  const rawSegments = trimmed.split(".");
  const segments: PathSegment[] = [];
  for (const raw of rawSegments) {
    const match = /^([A-Za-z0-9_-]+)((?:\[\d+\])*)$/.exec(raw);
    if (!match) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Invalid {{...}} expression: "${trimmed}".`);
    const [, key, indexPart] = match;
    const indices = [...(indexPart ?? "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (indices.length === 0) {
      segments.push({ key: key! });
    } else {
      segments.push({ key: key! }, ...indices.map((index) => ({ key: "", index })));
    }
  }
  return segments;
}

/**
 * `item` is a reserved first segment (not a step's own `key` - no
 * operation can ever be keyed "item", `WorkflowStepKeyField.vue`'s own
 * reserved-word list would already reject it same as "start") - resolves
 * against `state.currentItem`, the current For each element / Process in
 * batches chunk (engine.ts's own `runLoopOperation()`), instead of a
 * step's stored result. Replaces the old structured `Binding`'s
 * `source: "iteration"`, which had no `{{...}}` equivalent until now.
 * `state.currentItem` is only ever unset (`undefined`) outside a loop
 * body - a real per-iteration value is sourced from parsed JSON, which
 * has no `undefined` of its own (only `null`), so this check can't
 * mistake a legitimate falsy item for "not in a loop."
 */
function resolveRoot(state: RunState, key: string): unknown {
  if (key === "error") {
    if (state.currentError === undefined) {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "{{error...}} can only be used in the step an `error` output leads to.");
    }
    return state.currentError;
  }
  if (key === "item") {
    if (state.currentItem === undefined) {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "{{item...}} can only be used inside a For each/Process in batches body.");
    }
    return state.currentItem;
  }
  if (!state.resultsByKey.has(key)) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `{{${key}...}} references a step that hasn't run yet (forward reference or unreachable predecessor).`);
  }
  return state.resultsByKey.get(key);
}

/**
 * A step's result has a known shape, so a path it doesn't have is a mistake
 * in the design (`{{file.data.id}}` where create-file answers `asset`) - it
 * fails the step, naming what is there, instead of writing NULL into business
 * data. A `null` on the way is the data's own answer and resolves to it.
 * `start` (the trigger's payload) and `item` (an element of any list) come
 * from outside, where a field left out is ordinary: there a missing path
 * resolves to nothing, as an absent JSON field would.
 */
function resolvePath(state: RunState, segments: PathSegment[], expression: string): unknown {
  const [first, ...rest] = segments;
  if (!first) return undefined;
  const lenient = first.key === "start" || first.key === "item";
  let current: unknown = resolveRoot(state, first.key);
  let walked = first.key;
  for (const segment of rest) {
    if (current === null || current === undefined) return current;
    const parent = current;
    const step = segment.index !== undefined ? `[${segment.index}]` : `.${segment.key}`;
    let found: boolean;
    if (segment.index !== undefined) {
      found = Array.isArray(current) && segment.index < current.length;
      current = found ? (current as unknown[])[segment.index] : undefined;
    } else {
      found = typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment.key);
      current = found ? (current as Record<string, unknown>)[segment.key] : undefined;
    }
    if (!found) {
      if (lenient) return undefined;
      throw new TotalBaseError(
        "WORKFLOW_INVALID_DESIGN",
        `{{${expression.trim()}}}: ${walked} has no ${step.replace(/^\./, "")} - ${describeValue(parent)}.`,
      );
    }
    walked += step;
  }
  return current;
}

/** What the value a path stopped at holds, for the error naming it. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `it is a list of ${value.length}`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "it is an empty object";
    return `it has ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? `, ... (${keys.length} keys)` : ""}`;
  }
  return `it is ${JSON.stringify(value)}`;
}

function resolveExpression(state: RunState, expression: string): unknown {
  return resolvePath(state, parsePath(expression), expression);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function resolveString(state: RunState, text: string): unknown {
  const wholeMatch = WHOLE_VALUE_PATTERN.exec(text);
  if (wholeMatch) return resolveExpression(state, wholeMatch[1]!);
  if (!EXPRESSION_PATTERN.test(text)) return text;
  EXPRESSION_PATTERN.lastIndex = 0;
  return text.replace(EXPRESSION_PATTERN, (_match, expression: string) => stringify(resolveExpression(state, expression)));
}

/** Recursively resolves every `{{...}}` expression in a parsed JSON value - the entry point `createRecords`/`updateRecords`/`deleteRecords` call on `configuration.records`/`set`/`where`. */
export function resolveTemplates(value: unknown, state: RunState): unknown {
  if (typeof value === "string") return resolveString(state, value);
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, state));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, state)]));
  }
  return value;
}
