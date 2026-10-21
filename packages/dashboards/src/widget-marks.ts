import { isRecord } from "@totalbase/shared";
import { DASHBOARD_TOTAL_KINDS, DASHBOARD_FRAME_URL_TOKEN, checkFrameUrlTemplate, type DashboardValueKind } from "@totalbase/tb-catalog";
import type { DashboardVariable } from "./variables.js";

/**
 * What a widget's config reads beyond its query (Dashboards.md §5.13-§5.15): its thresholds' and
 * reference lines' values from a column of its row or a variable (D5), its click's formulas and targets (D6), its
 * table's totals (D28). Checked on save against what the query returns and the dashboard's variables (DB15 for these
 * places), resolved on the server when it runs - plain values the App draws and alerts will read.
 */

type TotalKind = (typeof DASHBOARD_TOTAL_KINDS)[number];

/** A threshold's or a reference's value as stored: a number, a statistic, `{column}` or `{variable}`. */
type ValueSource = number | string | { column: string } | { variable: string } | null | undefined;

function sourceOf(value: unknown): ValueSource {
  if (typeof value === "number" || typeof value === "string") return value;
  if (isRecord(value) && typeof value.column === "string") return { column: value.column };
  if (isRecord(value) && typeof value.variable === "string") return { variable: value.variable };
  return null;
}

/** Every value source in a widget's thresholds and references, with its path - `thresholds[1].from`. */
function valueSources(config: Record<string, unknown>): { path: string; source: ValueSource }[] {
  const out: { path: string; source: ValueSource }[] = [];
  if (Array.isArray(config.thresholds)) {
    config.thresholds.forEach((t, i) => {
      if (isRecord(t) && t.from !== undefined) out.push({ path: `thresholds[${i}].from`, source: sourceOf(t.from) });
    });
  }
  if (Array.isArray(config.references)) {
    config.references.forEach((r, i) => {
      if (!isRecord(r)) return;
      for (const key of ["value", "from", "to"]) if (r[key] !== undefined) out.push({ path: `references[${i}].${key}`, source: sourceOf(r[key]) });
    });
  }
  return out;
}

/** The variables a widget's marks read - resolved with its run. */
export function markVariables(config: Record<string, unknown>): string[] {
  return [...new Set(valueSources(config).flatMap(({ source }) => (isRecord(source) && "variable" in source ? [source.variable] : [])))];
}

/** A table's totals by column (D28): `columnSettings.<column>.total`. */
export function widgetTotals(config: Record<string, unknown>): Record<string, TotalKind> {
  const settings = isRecord(config.columnSettings) ? config.columnSettings : {};
  const out: Record<string, TotalKind> = {};
  for (const [column, setting] of Object.entries(settings)) {
    const total = isRecord(setting) ? setting.total : undefined;
    if (typeof total === "string" && (DASHBOARD_TOTAL_KINDS as readonly string[]).includes(total)) out[column] = total as TotalKind;
  }
  return out;
}

/** A widget's marks with their values resolved (D5): `null` where a column or a variable has no number. */
export interface DashboardWidgetMarks {
  thresholds?: (number | null)[];
  references?: { value?: number | string | null; from?: number | null; to?: number | null }[];
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The marks' values, from the row the widget shows (its last) and the variables' values. */
export function resolveMarks(config: Record<string, unknown>, rows: readonly Record<string, unknown>[], variableValues: Record<string, unknown>): DashboardWidgetMarks | undefined {
  const row = rows.length ? rows[rows.length - 1]! : {};
  const resolve = (value: unknown): number | string | null => {
    const source = sourceOf(value);
    if (typeof source === "number") return source;
    if (typeof source === "string") return source; // a statistic - ECharts computes it over the series
    if (isRecord(source) && "column" in source) return toNumber(row[source.column]);
    if (isRecord(source) && "variable" in source) return toNumber(variableValues[source.variable]);
    return null;
  };
  const marks: DashboardWidgetMarks = {};
  if (Array.isArray(config.thresholds)) marks.thresholds = config.thresholds.map((t) => (isRecord(t) && t.from !== undefined ? (resolve(t.from) as number | null) : null));
  if (Array.isArray(config.references)) {
    marks.references = config.references.map((r) => {
      if (!isRecord(r)) return {};
      return r.type === "band" ? { from: resolve(r.from) as number | null, to: resolve(r.to) as number | null } : { value: resolve(r.value) };
    });
  }
  return marks.thresholds || marks.references ? marks : undefined;
}

const FORMULA_REFERENCE = /\{\{\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

/** Every `{{root.name}}` in a formula. */
function formulaReferences(formula: string): { root: string; name: string }[] {
  return [...formula.matchAll(FORMULA_REFERENCE)].map((m) => ({ root: m[1]!, name: m[2]! }));
}

/** Every formula in a click (D6), with its path - its values, its filter's values, its target's variables. */
function clickFormulas(click: Record<string, unknown>): { path: string; formula: string }[] {
  const out: { path: string; formula: string }[] = [];
  const walk = (path: string, value: unknown) => {
    if (typeof value === "string") out.push({ path, formula: value });
    else if (Array.isArray(value)) value.forEach((v, i) => walk(`${path}[${i}]`, v));
    else if (isRecord(value)) for (const [k, v] of Object.entries(value)) walk(`${path}.${k}`, v);
  };
  for (const key of ["value", "pk", "url"]) if (typeof click[key] === "string") walk(`click.${key}`, click[key]);
  if (click.filter !== undefined) walk("click.filter", click.filter);
  if (isRecord(click.variables)) walk("click.variables", click.variables);
  return out;
}

/** The variable types a click may set, and a threshold may read. */
const SETTABLE = ["SELECT", "TEXT", "NUMBER"];
const NUMERIC = ["NUMBER", "SELECT"];

/**
 * What a widget's marks and click name that doesn't exist (DB15, D5, D6): a column its query doesn't return
 * (`columns` null when it couldn't be planned - not checked then), a variable the dashboard doesn't define or of a
 * type that can't serve, a formula root other than row, vars and user, a URL another site's. The click's targets
 * (a DataView, a dashboard) are the service's to look up.
 */
export function widgetReferenceErrors(
  label: string,
  config: Record<string, unknown>,
  columns: readonly string[] | null,
  variables: readonly DashboardVariable[],
  /** Each returned column's kind - a total's type checked against it (DB27). */
  kinds?: Readonly<Record<string, DashboardValueKind>>,
): string[] {
  const errors: string[] = [];
  const names = variables.map((v) => v.name);
  const returned = columns ? (columns.length ? columns.join(", ") : "no columns") : "";
  const column = (path: string, name: string) => {
    if (columns && !columns.includes(name)) errors.push(`${label}'s ${path}: the query returns no column "${name}" - it returns ${returned}.`);
  };
  const variable = (path: string, name: string, types: readonly string[]) => {
    const found = variables.find((v) => v.name === name);
    if (!found) errors.push(`${label}'s ${path}: the dashboard has no variable "${name}" - its variables: ${names.join(", ") || "none"}.`);
    else if (!types.includes(found.type)) errors.push(`${label}'s ${path}: "${name}" is a ${found.type} variable - it takes ${types.join(" or ")}.`);
  };
  for (const { path, source } of valueSources(config)) {
    if (isRecord(source) && "column" in source) column(`${path}.column`, source.column);
    if (isRecord(source) && "variable" in source) variable(`${path}.variable`, source.variable, NUMERIC);
  }
  const click = isRecord(config.click) ? config.click : null;
  if (click) {
    if (click.action === "FILTER" && typeof click.variable === "string") variable("click.variable", click.variable, SETTABLE);
    for (const { path, formula } of clickFormulas(click)) {
      for (const ref of formulaReferences(formula)) {
        if (ref.root === "row") column(path, ref.name);
        else if (ref.root === "vars") variable(path, ref.name, ["DATE_RANGE", ...SETTABLE]);
        else if (ref.root !== "user") errors.push(`${label}'s ${path}: {{${ref.root}.${ref.name}}} - a click's formulas read {{row.<column>}}, {{vars.<name>}} and {{user.<field>}}.`);
      }
    }
    if (click.action === "URL" && typeof click.url === "string") {
      const checked = checkFrameUrlTemplate(click.url, DASHBOARD_FRAME_URL_TOKEN, "{{vars.…}}, {{user.…}} and {{row.…}}");
      if ("problem" in checked) errors.push(`${label}'s click.url: ${checked.problem}`);
    }
  }
  const totals = widgetTotals(config);
  for (const [name, kind] of Object.entries(totals)) {
    column(`columnSettings.${name}.total`, name);
    // sum and avg add numbers; min and max compare numbers and dates; count counts anything (DB27).
    const of = kinds?.[name];
    if (of && (kind === "sum" || kind === "avg") && of !== "number") errors.push(`${label}'s columnSettings.${name}.total: ${kind} adds numbers - "${name}" is ${of === "time" ? "a date" : "not a number"}; count counts any column.`);
    if (of && (kind === "min" || kind === "max") && of !== "number" && of !== "time") errors.push(`${label}'s columnSettings.${name}.total: ${kind} compares numbers or dates - "${name}" is neither; count counts any column.`);
  }
  // A series by a value column the query returns - in wide format; a long one's keys are the Series column's values (DB29).
  const roles = isRecord(config.roles) ? config.roles : {};
  if (isRecord(config.series) && columns && (roles.series === undefined || roles.series === null) && (roles.group === undefined || roles.group === null) && !("group" in roles)) {
    for (const name of Object.keys(config.series)) column(`series.${name}`, name);
  }
  // A pivot's aggregate for a column that isn't a value is a typo, not a choice.
  if (isRecord(config.aggregates)) for (const name of Object.keys(config.aggregates)) column(`aggregates.${name}`, name);
  return errors;
}

/**
 * A click as an embed runs it (D6, §9.5): a FILTER on a variable its visitor may change (never a LOCKED or HIDDEN
 * one), a URL marked `inEmbeds` - else none: an embed has no App to open a DataView, a record or a dashboard in.
 */
export function embedClick(config: Record<string, unknown>, editable: ReadonlySet<string>): Record<string, unknown> | null {
  const click = isRecord(config.click) ? config.click : null;
  if (!click) return null;
  if (click.action === "FILTER" && typeof click.variable === "string" && editable.has(click.variable)) return click;
  if (click.action === "URL" && click.inEmbeds === true) return click;
  return null;
}

/** A presentation column by convention (§6) - a row's or a column's color - always sent. */
const PRESENTATION_COLUMN = /^_(?:[A-Za-z0-9_]+_)?color$/;

/**
 * The `_` columns an embed doesn't send (D6): those only a click reads that doesn't run there - an id a DataView
 * filter would use stays on the server.
 */
export function embedHiddenColumns(config: Record<string, unknown>, editable: ReadonlySet<string>): Set<string> {
  const click = isRecord(config.click) ? config.click : null;
  if (!click || embedClick(config, editable)) return new Set();
  const read = new Set(clickFormulas(click).flatMap(({ formula }) => formulaReferences(formula).filter((r) => r.root === "row").map((r) => r.name)));
  return new Set([...read].filter((name) => name.startsWith("_") && !PRESENTATION_COLUMN.test(name)));
}
