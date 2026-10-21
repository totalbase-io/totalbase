import { TotalBaseError } from "@totalbase/errors";
import { isRecord, UUID_PATTERN } from "@totalbase/shared";
import { periodSql } from "@totalbase/query-engine";
import { referencedVariableNames } from "./sql-variables.js";

/**
 * Dashboard variable definitions ($VAR.*) - see
 * Dashboards.md §3. A variable is a
 * filter the viewer picks, never a security boundary: values are bound
 * as parameters and validated here for type/shape, but a caller can send
 * any value a UI would offer.
 */
export const DASHBOARD_VARIABLE_TYPES = ["DATE_RANGE", "SELECT", "TEXT", "NUMBER"] as const;
export type DashboardVariableType = (typeof DASHBOARD_VARIABLE_TYPES)[number];

export const DATE_RANGE_PRESETS = [
  "last_hour",
  "today",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "this_month",
  "last_month",
  "this_year",
  "all",
] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

/** A fixed list's option: its value, and the text the viewer reads (its value when absent) - "Yes" for `true`. */
export interface DashboardStaticOption {
  value: string;
  label?: string;
}

/**
 * Where a SELECT's options come from: a fixed list; an options query (`SELECT value, label`); or a table (D22) -
 * its key the value, its row presentation the label, no SQL - narrowed by `filters`, each a column of it equal to
 * another variable's value (chained: the cities of the selected country; no value, no filter).
 */
export type DashboardVariableOptions =
  | { source: "STATIC"; values: DashboardStaticOption[] }
  | { source: "QUERY"; query: string }
  | { source: "TABLE"; resource: string; filters?: { column: string; variable: string }[] };

/**
 * A variable's default (D22) - the shape a page's Value takes: a constant, or a field of the viewer's own user row
 * ("the operator's branch"), resolved for each viewer.
 */
export type DashboardVariableDefault = { source: "constant"; value: unknown } | { source: "user"; field: string };

export interface DashboardVariable {
  name: string;
  label: string;
  type: DashboardVariableType;
  /** SELECT only. */
  multiple?: boolean;
  /** SELECT only. */
  options?: DashboardVariableOptions;
  /** Absent = NULL. A constant's value has a value's shape (normalizeVariableValue). */
  default?: DashboardVariableDefault;
  /**
   * SELECT with an options query only: the variables its query reads as
   * `$VAR.*` (Dashboards.md §3.6) - derived from the query by
   * validateVariables(), so a host reloads the options when one changes.
   */
  dependsOn?: string[];
}

export type DateRangeValue = DateRangePreset | { from: string; to: string };

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VARIABLES = 20;
const MAX_TEXT_LENGTH = 200;
const MAX_STATIC_OPTIONS = 200;

function invalid(message: string): never {
  throw new TotalBaseError("DASHBOARD_VARIABLE_INVALID", message);
}

function validateDate(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !ISO_DATE.test(raw) || Number.isNaN(Date.parse(raw))) {
    invalid(`${what} must be a YYYY-MM-DD date.`);
  }
  return raw;
}

/**
 * Normalizes one value for `variable`, or returns null (= unset, binds
 * NULL). Throws DASHBOARD_VARIABLE_INVALID for a value of the wrong shape.
 */
export function normalizeVariableValue(variable: DashboardVariable, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) return null;
  const label = `$VAR.${variable.name}`;

  switch (variable.type) {
    case "DATE_RANGE": {
      if (typeof raw === "string") {
        if (!DATE_RANGE_PRESETS.includes(raw as DateRangePreset)) invalid(`${label}: unknown preset "${raw}".`);
        return raw;
      }
      if (!isRecord(raw)) invalid(`${label} must be a preset or {from, to}.`);
      const from = validateDate(raw.from, `${label}.from`);
      const to = validateDate(raw.to, `${label}.to`);
      if (from > to) invalid(`${label}: from is after to.`);
      return { from, to };
    }
    case "SELECT": {
      const values = variable.multiple ? (Array.isArray(raw) ? raw : [raw]) : [raw];
      if (!variable.multiple && Array.isArray(raw)) invalid(`${label} takes a single value.`);
      const strings = values.map((v) => {
        if (typeof v !== "string" && typeof v !== "number") invalid(`${label} values must be text.`);
        return String(v);
      });
      if (variable.options?.source === "STATIC") {
        const allowed = new Set(variable.options.values.map((o) => o.value));
        for (const v of strings) if (!allowed.has(v)) invalid(`${label}: "${v}" is not one of its options.`);
      }
      return variable.multiple ? strings : strings[0];
    }
    case "TEXT": {
      if (typeof raw !== "string" && typeof raw !== "number") invalid(`${label} must be text.`);
      const text = String(raw);
      if (text.length > MAX_TEXT_LENGTH) invalid(`${label} is longer than ${MAX_TEXT_LENGTH} characters.`);
      return text;
    }
    case "NUMBER": {
      const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value)) invalid(`${label} must be a number.`);
      return value;
    }
  }
}

/** Validates and normalizes a whole definition list (admin input). */
function onlyKeys(path: string, value: Record<string, unknown>, keys: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) invalid(`${path} has no "${unknown}" - it takes: ${keys.join(", ")}.`);
}

export function validateVariables(raw: unknown): DashboardVariable[] {
  if (!Array.isArray(raw)) invalid("variables must be an array.");
  if (raw.length > MAX_VARIABLES) invalid(`A dashboard can have at most ${MAX_VARIABLES} variables.`);
  const names = new Set<string>();

  const variables = raw.map((item, index): DashboardVariable => {
    if (!isRecord(item)) invalid("Each variable must be an object.");
    // Every key at every level, a refusal naming its path (DB20) - never ignored in silence.
    onlyKeys(`variables[${index}]`, item, ["name", "label", "type", "multiple", "options", "default", "dependsOn"]);
    if (isRecord(item.options)) {
      const source = item.options.source;
      onlyKeys(`variables[${index}].options`, item.options, source === "STATIC" ? ["source", "values"] : source === "QUERY" ? ["source", "query"] : ["source", "resource", "filters"]);
      if (source === "STATIC" && Array.isArray(item.options.values)) item.options.values.forEach((v, i) => isRecord(v) && onlyKeys(`variables[${index}].options.values[${i}]`, v, ["value", "label"]));
      if (source === "TABLE" && Array.isArray(item.options.filters)) item.options.filters.forEach((f, i) => isRecord(f) && onlyKeys(`variables[${index}].options.filters[${i}]`, f, ["column", "variable"]));
    }
    if (isRecord(item.default)) onlyKeys(`variables[${index}].default`, item.default, item.default.source === "user" ? ["source", "field"] : ["source", "value"]);
    const name = item.name;
    if (typeof name !== "string" || !NAME.test(name)) {
      invalid(`Variable name "${String(name)}" must be lowercase letters, digits and underscores, starting with a letter (max 32).`);
    }
    if (names.has(name)) invalid(`Duplicate variable name "${name}".`);
    // The App's open tab is `?tab=` (D7) - a variable can't share the address.
    if (name === "tab") throw new TotalBaseError("DASHBOARD_VARIABLE_RESERVED", 'A variable can\'t be named "tab" - the App keeps the open tab in ?tab=.');
    names.add(name);

    const type = item.type as DashboardVariableType;
    if (!DASHBOARD_VARIABLE_TYPES.includes(type)) invalid(`Variable "${name}": type must be one of ${DASHBOARD_VARIABLE_TYPES.join(", ")}.`);
    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, 64) : name;

    const variable: DashboardVariable = { name, label, type };
    if (type === "SELECT") {
      variable.multiple = item.multiple === true;
      const options = item.options;
      if (!isRecord(options)) invalid(`Variable "${name}": a SELECT needs options.`);
      if (options.source === "STATIC") {
        if (!Array.isArray(options.values) || options.values.length === 0) invalid(`Variable "${name}": list at least one option.`);
        if (options.values.length > MAX_STATIC_OPTIONS) invalid(`Variable "${name}": at most ${MAX_STATIC_OPTIONS} options.`);
        // Each a value, or {value, label} - "Yes / No / All": [{value: "true", label: "Yes"}, {value: "false", label: "No"}], unset is All.
        const seen = new Set<string>();
        const values: DashboardStaticOption[] = [];
        for (const raw of options.values) {
          const option: Record<string, unknown> = isRecord(raw) ? raw : { value: raw };
          if (typeof option.value !== "string" && typeof option.value !== "number" && typeof option.value !== "boolean") invalid(`Variable "${name}": each option is a value or {value, label}.`);
          const value = String(option.value);
          if (seen.has(value)) continue;
          seen.add(value);
          const label = typeof option.label === "string" && option.label.trim() ? option.label.trim().slice(0, 64) : undefined;
          values.push(label ? { value, label } : { value });
        }
        variable.options = { source: "STATIC", values };
      } else if (options.source === "QUERY") {
        if (typeof options.query !== "string" || !options.query.trim()) invalid(`Variable "${name}": the options query is empty.`);
        variable.options = { source: "QUERY", query: options.query };
      } else if (options.source === "TABLE") {
        if (typeof options.resource !== "string" || !UUID_PATTERN.test(options.resource)) invalid(`Variable "${name}": options.resource is the table's resource id.`);
        const filters = options.filters === undefined || options.filters === null ? [] : options.filters;
        if (!Array.isArray(filters)) invalid(`Variable "${name}": options.filters is a list of {column, variable}.`);
        variable.options = {
          source: "TABLE",
          resource: options.resource,
          ...(filters.length > 0 && {
            filters: filters.map((f) => {
              if (!isRecord(f) || typeof f.column !== "string" || typeof f.variable !== "string") invalid(`Variable "${name}": each filter is {column, variable}.`);
              return { column: f.column, variable: f.variable };
            }),
          }),
        };
      } else {
        invalid(`Variable "${name}": options.source must be STATIC, QUERY or TABLE.`);
      }
    }
    if (item.default !== undefined && item.default !== null) {
      const def = item.default;
      if (!isRecord(def) || (def.source !== "constant" && def.source !== "user")) {
        invalid(`Variable "${name}": default is {"source": "constant", "value": ...} or {"source": "user", "field": "<a column of the user>"} - got ${JSON.stringify(def)}.`);
      }
      if (def.source === "user") {
        if (typeof def.field !== "string" || !/^[a-z_][a-z0-9_]*$/.test(def.field)) invalid(`Variable "${name}": a user default names a column of users.`);
        variable.default = { source: "user", field: def.field };
      } else {
        const value = normalizeVariableValue(variable, def.value);
        if (value !== null) variable.default = { source: "constant", value };
      }
    }
    return variable;
  });
  resolveDependencies(variables);
  return variables;
}

/**
 * Dependent variables (Dashboards.md §3.6): an options query may
 * read other variables as `$VAR.*` - each must exist, never itself, and the
 * chains must be acyclic ("the cities of the selected country").
 */
function resolveDependencies(variables: DashboardVariable[]): void {
  const byName = new Map(variables.map((v) => [v.name, v]));
  for (const variable of variables) {
    const options = variable.options;
    if (options?.source !== "QUERY" && options?.source !== "TABLE") continue;
    const refs = options.source === "QUERY" ? referencedVariableNames(options.query) : [...new Set((options.filters ?? []).map((f) => f.variable))];
    for (const ref of refs) {
      if (ref === variable.name) invalid(`Variable "${variable.name}": its options can't depend on itself.`);
      if (!byName.has(ref)) invalid(`Variable "${variable.name}": its options read $VAR.${ref}, which doesn't exist.`);
    }
    if (refs.length > 0) variable.dependsOn = refs;
  }
  const state = new Map<string, "VISITING" | "DONE">();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === "DONE") return;
    if (state.get(name) === "VISITING") invalid(`The options queries depend on each other in a loop: ${[...path, name].join(" -> ")}.`);
    state.set(name, "VISITING");
    for (const next of byName.get(name)?.dependsOn ?? []) visit(next, [...path, name]);
    state.set(name, "DONE");
  };
  for (const variable of variables) visit(variable.name, []);
}

/**
 * A DATE_RANGE value -> the SQL that computes its bounds, run by
 * PostgreSQL itself so the session time zone decides where "this month"
 * starts. Presets are fixed strings; a custom range binds its two dates
 * ($1/$2). `to` is exclusive: a custom range's last day is included.
 *
 * With them, the **previous period** (D22): `prev_from`/`prev_to`, as long and
 * just before - a calendar preset's previous unit (this month → last month,
 * today → yesterday), any other range shifted back by its own length.
 */
export function dateRangeBoundsSql(value: DateRangeValue): { sql: string; params: unknown[] } {
  const shifted = (from: string, to: string) => `SELECT f AS "from", t AS "to", f - (t - f) AS prev_from, f AS prev_to FROM (SELECT ${from} AS f, ${to} AS t) b`;
  const calendar = (period: "today" | "this_month" | "last_month" | "this_year", unit: string) =>
    `SELECT f AS "from", t AS "to", f - interval '${unit}' AS prev_from, f AS prev_to FROM (SELECT ${periodSql(period, "from")} AS f, ${periodSql(period, "to")} AS t) b`;
  if (typeof value !== "string") {
    return { sql: shifted("$1::date::timestamptz", "($2::date + 1)::timestamptz"), params: [value.from, value.to] };
  }
  const presets: Record<DateRangePreset, string> = {
    last_hour: shifted("now() - interval '1 hour'", "now()"),
    // Calendar presets are the query language's $PERIOD.* - one computation of where a period starts.
    today: calendar("today", "1 day"),
    last_7_days: shifted("now() - interval '7 days'", "now()"),
    last_30_days: shifted("now() - interval '30 days'", "now()"),
    last_90_days: shifted("now() - interval '90 days'", "now()"),
    this_month: calendar("this_month", "1 month"),
    last_month: calendar("last_month", "1 month"),
    this_year: calendar("this_year", "1 year"),
    all: `SELECT NULL::timestamptz AS "from", NULL::timestamptz AS "to", NULL::timestamptz AS prev_from, NULL::timestamptz AS prev_to`,
  };
  return { sql: presets[value], params: [] };
}
