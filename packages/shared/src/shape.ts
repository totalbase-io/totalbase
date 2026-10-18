import { isRecord } from "./values.js";

/**
 * The one shape validator: what a stored document may hold - a dashboard widget's props
 * (`@totalbase/tb-catalog`: `dashboard-shapes.ts`), a canvas control's literal props (`widget-control.ts`), a DataView's
 * `view_config` (`@totalbase/dataviews`), a workflow operation's configuration (`@totalbase/workflows`) -
 * described as plain data and checked at every level, each refusal naming its path
 * (`series.facturado.colour`). Plain data, no Vue and no `pg`: the server (save, publish), the MCP (the
 * guide) and the admin (the inspector) read the same description, so a nested key is never ignored in
 * silence, and no caller grows a checker of its own.
 *
 * Null and undefined are "unset": an object's field, a map's entry and a list's item may be unset
 * (`required` names an object's fields that may not); the value a caller hands in may be unset only
 * when its shape is `optional`.
 */
export type Shape = ShapeForm & {
  /** A further condition once the shape fits - the problem ("lists a column twice"), or null. */
  check?: ShapeCheck;
};

export type ShapeCheck = (value: unknown) => string | null;

type ShapeForm =
  | { type: "text"; max?: number }
  /** A finite number; `integer`, `min` and `max` narrow it. */
  | { type: "number"; integer?: boolean; min?: number; max?: number }
  | { type: "boolean" }
  | { type: "enum"; options: readonly string[] }
  /**
   * A JSON value of any shape - a filter object in the `where` grammar, checked where it's used. With
   * bounds, it is walked without ever descending past `maxDepth` (the value itself being level 1), so a
   * pathologically deep value can't exhaust the stack; `maxKeys` bounds any one object in it, `text` is
   * the shape of every string in it.
   */
  | { type: "any"; maxDepth?: number; maxKeys?: number; text?: Shape }
  /** Named fields, each optional unless `required` lists it. */
  | { type: "object"; fields: Readonly<Record<string, Shape>>; required?: readonly string[] }
  /** Any keys (a column's or a series' name), each value of one shape. */
  | { type: "map"; of: Shape; key?: string }
  | { type: "list"; of: Shape; max?: number }
  /** One of several forms - the first that fits; `tag` picks an object form by that field's value (`action`). */
  | { type: "oneOf"; forms: readonly Shape[]; label: string; tag?: string }
  /** The shape, or unset. */
  | { type: "optional"; of: Shape }
  /** A condition of its own, when no form above says it: `takes` is what it takes, for the refusal. */
  | { type: "custom"; takes: string; check: ShapeCheck };

export interface ShapeIssue {
  /** Where: the value's path, with the key an object doesn't have (`series.facturado.colour`). */
  path: string;
  /** The refusal, starting with the path: `series.facturado has no "colour" - it takes: label, color, ...`. */
  message: string;
  /** What went wrong - a caller that words its own refusals (a limit's name) tells them apart by it. */
  kind: "type" | "unknown" | "missing" | "size" | "depth" | "keys" | "check";
}

/** What a shape takes, for a refusal - "one of: bar, line, area", "a number", "{column}". */
export function describeShape(shape: Shape): string {
  switch (shape.type) {
    case "text":
      return "text";
    case "number":
      return shape.integer ? `a whole number${shape.min !== undefined && shape.max !== undefined ? ` from ${shape.min} to ${shape.max}` : ""}` : "a number";
    case "boolean":
      return "true or false";
    case "enum":
      return `one of ${shape.options.join(", ")}`;
    case "any":
      return "a value";
    case "object":
      return `an object {${Object.keys(shape.fields).join(", ")}}`;
    case "map":
      return `an object by ${shape.key ?? "name"}`;
    case "list":
      return "a list";
    case "oneOf":
      return shape.label;
    case "optional":
      return describeShape(shape.of);
    case "custom":
      return shape.takes;
  }
}

/** The keys of an object, a list's items and a text's uniqueness: the first value seen twice, as a problem. */
export function distinct(what: string, by?: string): ShapeCheck {
  return (value) => {
    if (!Array.isArray(value)) return null;
    const seen = new Set<unknown>();
    for (const item of value) {
      const key = by === undefined ? item : isRecord(item) ? item[by] : undefined;
      if (key === undefined) continue;
      if (seen.has(key)) return `lists ${what} ${JSON.stringify(key)} twice`;
      seen.add(key);
    }
    return null;
  };
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** Every problem with `value` against `shape`, each naming its path (`series.facturado.color`). */
export function shapeErrors(path: string, shape: Shape, value: unknown): ShapeIssue[] {
  const issues = formErrors(path, shape, value);
  if (issues.length === 0 && shape.type !== "custom" && shape.check && value !== null && value !== undefined) {
    const problem = shape.check(value);
    if (problem) issues.push({ path, kind: "check", message: `${path} ${problem}.` });
  }
  return issues;
}

/** An unset field, entry or item passes; `required` is the object's own check. */
function memberErrors(path: string, shape: Shape, value: unknown): ShapeIssue[] {
  return value === null || value === undefined ? [] : shapeErrors(path, shape, value);
}

function formErrors(path: string, shape: Shape, value: unknown): ShapeIssue[] {
  const got = () => ` - got ${JSON.stringify(value)}`;
  const wrong = (): ShapeIssue[] => [{ path, kind: "type", message: `${path} takes ${describeShape(shape)}${got()}.` }];
  switch (shape.type) {
    case "optional":
      return value === null || value === undefined ? [] : shapeErrors(path, shape.of, value);
    case "text":
      if (typeof value !== "string") return wrong();
      return shape.max !== undefined && value.length > shape.max ? [{ path, kind: "size", message: `${path} is at most ${shape.max} characters.` }] : [];
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return wrong();
      if (shape.integer && !Number.isInteger(value)) return wrong();
      if ((shape.min !== undefined && value < shape.min) || (shape.max !== undefined && value > shape.max)) return wrong();
      return [];
    }
    case "boolean":
      return typeof value === "boolean" ? [] : wrong();
    case "enum":
      return typeof value === "string" && shape.options.includes(value) ? [] : [{ path, kind: "type", message: `${path} is one of ${shape.options.join(", ")}${got()}.` }];
    case "custom": {
      const problem = shape.check(value);
      return problem ? [{ path, kind: "check", message: `${path} ${problem}.` }] : [];
    }
    case "any":
      return shape.maxDepth === undefined && shape.maxKeys === undefined && shape.text === undefined ? [] : boundedErrors(path, shape, value);
    case "object": {
      if (!isRecord(value)) return wrong();
      const issues: ShapeIssue[] = [];
      for (const key of Object.keys(value)) {
        if (!(key in shape.fields)) issues.push({ path: join(path, key), kind: "unknown", message: `${path} has no "${key}" - it takes: ${Object.keys(shape.fields).join(", ")}.` });
      }
      for (const key of shape.required ?? []) {
        if (value[key] === undefined || value[key] === null) issues.push({ path, kind: "missing", message: `${path} needs "${key}".` });
      }
      for (const [key, field] of Object.entries(shape.fields)) issues.push(...memberErrors(join(path, key), field, value[key]));
      return issues;
    }
    case "map":
      if (!isRecord(value)) return wrong();
      return Object.entries(value).flatMap(([key, item]) => memberErrors(join(path, key), shape.of, item));
    case "list":
      if (!Array.isArray(value)) return wrong();
      if (shape.max !== undefined && value.length > shape.max) return [{ path, kind: "size", message: `${path} holds at most ${shape.max}.` }];
      return value.flatMap((item, index) => memberErrors(`${path}[${index}]`, shape.of, item));
    case "oneOf": {
      if (shape.tag) {
        const tag = shape.tag;
        const forms = shape.forms.filter((f): f is Extract<Shape, { type: "object" }> => f.type === "object");
        const tagOptions = (form: Extract<Shape, { type: "object" }>) => (form.fields[tag] as { options?: readonly string[] } | undefined)?.options;
        const options = forms.map((f) => tagOptions(f)?.[0]).filter((o): o is string => o !== undefined);
        if (!isRecord(value) || typeof value[tag] !== "string") return [{ path, kind: "missing", message: `${path} needs "${tag}" - one of ${options.join(", ")}${got()}.` }];
        const form = forms.find((f) => tagOptions(f)?.includes(value[tag] as string));
        return form ? shapeErrors(path, form, value) : [{ path: join(path, tag), kind: "type", message: `${path}.${tag} is one of ${options.join(", ")} - got ${JSON.stringify(value[tag])}.` }];
      }
      for (const form of shape.forms) {
        if (shapeErrors(path, form, value).length === 0) return [];
      }
      // The closest form's own problems when the value is an object - the object form sharing a key with it, or
      // the only object form there is - else what it takes.
      const objectForms = shape.forms.filter((f) => f.type === "object");
      const objectForm = isRecord(value) ? (objectForms.find((f) => Object.keys(value).some((k) => k in f.fields)) ?? (objectForms.length === 1 ? objectForms[0] : undefined)) : undefined;
      return objectForm ? shapeErrors(path, objectForm, value) : wrong();
    }
  }
}

/** A bounded `any`: depth and keys from the value's own level, every string against `text`. */
function boundedErrors(path: string, shape: Extract<Shape, { type: "any" }>, value: unknown): ShapeIssue[] {
  const issues: ShapeIssue[] = [];
  const walk = (at: string, node: unknown, depth: number): void => {
    if (typeof node === "string") {
      if (shape.text) issues.push(...shapeErrors(at, shape.text, node));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (shape.maxDepth !== undefined && depth > shape.maxDepth) {
      issues.push({ path, kind: "depth", message: `${path} is nested more than ${shape.maxDepth} levels deep.` });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(`${at}[${index}]`, item, depth + 1));
      return;
    }
    const keys = Object.keys(node);
    if (shape.maxKeys !== undefined && keys.length > shape.maxKeys) {
      issues.push({ path: at, kind: "keys", message: `${at} has ${keys.length} fields; the limit is ${shape.maxKeys}.` });
    }
    for (const key of keys) walk(join(at, key), (node as Record<string, unknown>)[key], depth + 1);
  };
  walk(path, value, 1);
  return issues;
}
