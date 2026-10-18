import {
  checkConstraintValues,
  dashboardDecision,
  decisionLanguage,
  integerRange,
  type ColumnPresentation,
  type DashboardDecision,
  type DashboardDecisionCode,
  type DashboardDecisionLanguage,
  type RowPresentation,
} from "@totalbase/tb-catalog";
import { getRelationDetail, type RelationDetail } from "@totalbase/pg-catalog";
import { quoteIdentifier, type Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { mechanicalLabel, suggestPresentation } from "@totalbase/resources";
import type { DashboardSpec, DashboardSpecWidget } from "./dashboard-spec.js";
import type { DashboardVariable } from "./variables.js";

/**
 * The dashboard assistant (Specification_Dashboards.md §10.7, D27): one table or view read from the catalog -
 * types, constraints, foreign keys, a view's origins, `pg_stats` and `pg_class.reltuples`, never a row of it, never
 * a column's name - and a dashboard proposed for it in the DashboardSpec shape (§8.3), every role set explicitly.
 * Nothing is applied. Every choice says why as a decision (`{code, message, detail?}`, §5.19, DM3).
 *
 * Two pure steps, unit-tested on their own - `analyzeColumns` (each column's role) and `proposeDashboard` (the
 * spec, what's offered unticked, what's missing and the security options) - and `suggestDashboard`, which reads
 * the catalog into their input.
 */

// --- Shapes -------------------------------------------------------------------

/** What a column is to a dashboard. */
export type SuggestColumnRole = "moment" | "deadline" | "measure" | "category" | "dimension" | "identifier" | "place" | "file" | "discarded";

/** A foreign key's target, as the proposal needs it: how its rows show, how many it has, what it points at. */
export interface SuggestForeignKeyTarget {
  oid: number;
  schema: string;
  table: string;
  /** The column the foreign key references. */
  key: string;
  /** Its TotalBase resource (an active TABLE) - a list variable's `options.resource`; null: none. */
  resourceId: string | null;
  /** pg_class.reltuples - null when never analyzed. */
  rows: number | null;
  rowPresentation: RowPresentation | null;
  /** suggest_presentation's display field (its first unique, required text) - for a target with no row presentation. */
  suggestedDisplayField: string | null;
  columns: string[];
  /** Its own single-column foreign keys - a chained list (D9). */
  foreignKeys: { column: string; targetOid: number }[];
}

/** Everything the analysis reads about one column - from the catalog and pg_stats (a view's: its origin's). */
export interface SuggestColumnFacts {
  /** Its name in the analyzed table or view. */
  name: string;
  /** format_type() - a domain's base type. */
  dataType: string;
  nullable: boolean;
  isIdentity: boolean;
  isGenerated: boolean;
  defaultExpression: string | null;
  typeKind: "base" | "enum" | "domain";
  /** An enum's labels, a domain's CHECK list - null when none. */
  typeValues: string[] | null;
  /** Its relation's single-column primary key. */
  primaryKey: boolean;
  /** A single-column UNIQUE. */
  unique: boolean;
  /** Its relation's CHECK constraints, and its name in them (a view column's origin's name). */
  checks: { expression: string; message: string | null }[];
  checkName: string;
  foreignKey: SuggestForeignKeyTarget | null;
  /** A foreign key to totalbase.files. */
  fileReference: boolean;
  /** pg_stats - null when the column has none (new, or a virtual generated one). */
  stats: { nDistinct: number; nullFrac: number } | null;
  /** Its relation's pg_class.reltuples - null when never analyzed. */
  relationRows: number | null;
  /** A view's column: the table column it is (`schema.table.column`), null for an expression; unset on a table. */
  origin?: string | null;
  /** Its presentation (a view's, over its origin's). */
  presentation: Pick<ColumnPresentation, "label" | "displayFormat" | "options">;
}

export interface SuggestRelation {
  schema: string;
  name: string;
  type: "TABLE" | "VIEW";
  /** Its TotalBase resource - null when it has none. */
  resourceId: string | null;
}

export interface DashboardColumnAnalysis {
  column: string;
  role: SuggestColumnRole;
  reason: DashboardDecision;
  /** The time axis's other candidates (by position). */
  alternatives?: string[];
  /** A view's column: the table column whose role it took. */
  origin?: string;
  /** A measure: how it aggregates - a decimal is added up, a whole number averaged. */
  aggregate?: "sum" | "avg";
  /** A category: its values, when a CHECK, an enum or a domain lists them. */
  values?: string[];
  /** A dimension or a file: the table it points at. */
  references?: string;
}

/** One decision about the proposal: where (`widgets[2]`, `more[0]`, `variables[1]`, `columns.<name>`) and why. */
export interface DashboardSuggestionReason {
  path: string;
  reason: DashboardDecision;
}

/** A security option (D27 §5): the same proposal, filtered by who views it - off unless chosen. */
export interface DashboardSecurityOption {
  key: "openOnViewers" | "onlyViewers";
  /** The dimension it filters, and the column of users with a foreign key to the same table. */
  column: string;
  field: string;
  reason: DashboardDecision;
  spec: DashboardSpec;
  more: DashboardSpecWidget[];
}

export interface DashboardSuggestion {
  relation: SuggestRelation;
  analysis: DashboardColumnAnalysis[];
  /** The proposed dashboard - applied as is with apply_dashboard (§8.3). */
  spec: DashboardSpec;
  /** Widgets offered unticked, in the same shape. */
  more: DashboardSpecWidget[];
  /** Why each widget, variable and column decision is there. */
  reasons: DashboardSuggestionReason[];
  /** What's missing for a better dashboard - each with what to do. */
  missing: DashboardDecision[];
  security: { notice: DashboardDecision; options: DashboardSecurityOption[] };
}

// --- Analysis -----------------------------------------------------------------

const TIME = /^(date|timestamp)\b/;
const TIMESTAMP = /^timestamp\b/;
const INTEGER = /^(smallint|integer|bigint)$/;
const DECIMAL = /^(numeric|decimal|real|double precision)\b/;
const TEXT = /^(text|character varying|character|citext|varchar|char)\b/;
const NOW = /\b(now\(\)|current_timestamp|current_date|localtimestamp|transaction_timestamp\(\)|statement_timestamp\(\)|clock_timestamp\(\))/i;
/** A category's distinct values: up to 31 (a day of the month, an hour, a weekday). */
const CATEGORY_MAX = 31;
/** A donut: up to 7 slices. */
const DONUT_MAX = 7;
/** A list variable: a target of up to 50 rows. */
const LIST_MAX_ROWS = 50;
const KPI_TICKED = 4;

/** Distinct values per pg_stats: n_distinct, or its fraction of the rows when negative - null without stats. */
function distinctValues(facts: SuggestColumnFacts): number | null {
  if (!facts.stats) return null;
  const n = facts.stats.nDistinct;
  if (n >= 0) return Math.round(n);
  return facts.relationRows !== null && facts.relationRows > 0 ? Math.round(-n * facts.relationRows) : null;
}

function checkList(facts: SuggestColumnFacts): string[] | null {
  return checkConstraintValues(facts.checkName, facts.checks.map((c) => c.expression));
}

interface Classified {
  role: SuggestColumnRole;
  code: DashboardDecisionCode;
  detail?: string;
  aggregate?: "sum" | "avg";
  values?: string[];
  references?: string;
  /** Goes to `missing` too. */
  missing?: boolean;
  /** A time-axis candidate: 1 a required date defaulting to now, 2 any other required date. */
  momentTier?: 1 | 2;
}

function classify(f: SuggestColumnFacts): Classified {
  const type = f.dataType.toLowerCase();
  if (f.origin === null) {
    const numeric = DECIMAL.test(type) || INTEGER.test(type);
    return numeric ? { role: "measure", code: "view-computed", detail: f.dataType, aggregate: INTEGER.test(type) ? "avg" : "sum" } : { role: "discarded", code: "view-computed", detail: f.dataType };
  }
  if (f.fileReference) return { role: "file", code: "file-reference", detail: "totalbase.files", references: "totalbase.files" };
  if (f.primaryKey) return { role: "identifier", code: "identifier-primary-key", detail: f.dataType };
  const distinct = distinctValues(f);
  if (f.stats && (f.stats.nullFrac >= 0.9999 || (distinct !== null && distinct <= 1))) {
    return { role: "discarded", code: "single-value", detail: `n_distinct ${f.stats.nDistinct}, null_frac ${f.stats.nullFrac}`, missing: true };
  }
  if (f.foreignKey) {
    const target = f.foreignKey;
    const references = `${target.schema}.${target.table}`;
    const presented = Boolean(target.rowPresentation?.displayField || target.rowPresentation?.displayTemplate);
    return presented
      ? { role: "dimension", code: "dimension-foreign-key", detail: `→ ${references}`, references }
      : { role: "dimension", code: "dimension-suggested-presentation", detail: `→ ${references}${target.suggestedDisplayField ? ` (${target.suggestedDisplayField})` : ""}`, references, missing: true };
  }
  if (f.unique) return { role: "identifier", code: "identifier-unique", detail: `UNIQUE ${f.dataType}` };
  if (f.isIdentity || /^nextval\(/i.test(f.defaultExpression ?? "")) return { role: "identifier", code: "identifier-sequence", detail: f.isIdentity ? "identity" : f.defaultExpression! };
  if (type === "point") return { role: "place", code: "place-point", detail: f.dataType };
  if (TIME.test(type)) {
    const def = f.defaultExpression ?? "";
    if (NOW.test(def) && /\+/.test(def)) return { role: "deadline", code: "deadline-future-default", detail: `DEFAULT ${def}` };
    if (!f.nullable && NOW.test(def)) return { role: "moment", code: "moment-default-now", detail: `${f.dataType} NOT NULL DEFAULT ${def}`, momentTier: 1 };
    if (!f.nullable) return { role: "moment", code: "moment-not-null", detail: `${f.dataType} NOT NULL`, momentTier: 2 };
    return { role: "discarded", code: "date-other", detail: f.dataType };
  }
  if (type === "boolean") return { role: "category", code: "category-boolean", detail: "boolean", values: ["true", "false"] };
  if (f.typeKind === "enum" && f.typeValues?.length) return { role: "category", code: "category-enum", detail: `ENUM (${f.typeValues.length} values)`, values: f.typeValues };
  if (f.typeKind === "domain" && f.typeValues?.length) return { role: "category", code: "category-domain", detail: `DOMAIN (${f.typeValues.length} values)`, values: f.typeValues };
  const list = checkList(f);
  if (list?.length) return { role: "category", code: "category-check-list", detail: `CHECK IN (${list.length} values)`, values: list };
  if (DECIMAL.test(type)) return { role: "measure", code: "measure-numeric", detail: f.dataType, aggregate: "sum" };
  if (INTEGER.test(type)) {
    const range = integerRange(f.checkName, type, f.checks);
    if (range && range.max - range.min + 1 <= CATEGORY_MAX && range.max >= range.min) return { role: "category", code: "category-check-range", detail: `CHECK ${range.min}..${range.max}` };
    if (distinct === null) return { role: "measure", code: "no-stats", detail: f.dataType, aggregate: "avg", missing: true };
    if (distinct >= 2 && distinct <= CATEGORY_MAX) return { role: "category", code: "category-few-values", detail: `n_distinct ${distinct}` };
    return { role: "measure", code: "measure-integer-many", detail: `n_distinct ${distinct}`, aggregate: "avg" };
  }
  if (type === "uuid") return { role: "discarded", code: "uuid-without-fk", detail: distinct !== null ? `uuid, n_distinct ${distinct}` : "uuid", missing: true };
  if (TEXT.test(type)) {
    if (distinct !== null && distinct > CATEGORY_MAX) return { role: "identifier", code: "identifier-free-text", detail: `n_distinct ${distinct}` };
    return { role: "discarded", code: "text-without-check", detail: distinct !== null ? `${f.dataType}, n_distinct ${distinct}` : f.dataType, missing: true };
  }
  return { role: "discarded", code: "type-not-analyzed", detail: f.dataType };
}

/**
 * Each column's role and why (D27 §2) - by its type, constraints, origin and statistics, never its name: the same
 * table with its columns renamed reads the same. The time axis is the first required date defaulting to now (the
 * others its alternatives), else the first required date.
 */
export function analyzeColumns(columns: readonly SuggestColumnFacts[], language: DashboardDecisionLanguage): { analysis: DashboardColumnAnalysis[]; missing: DashboardDecision[] } {
  const classified = columns.map((f) => ({ f, c: classify(f) }));
  const tier1 = classified.filter((x) => x.c.momentTier === 1);
  const tier2 = classified.filter((x) => x.c.momentTier === 2);
  const chosen = tier1[0] ?? tier2[0];
  const candidates = [...tier1, ...tier2];
  const missing: DashboardDecision[] = [];
  const analysis = classified.map(({ f, c }): DashboardColumnAnalysis => {
    const entry: DashboardColumnAnalysis = { column: f.name, role: c.role, reason: dashboardDecision(c.code, language, { column: f.name }, c.detail) };
    if (c.momentTier) {
      if (chosen && f === chosen.f) {
        const alternatives = candidates.filter((x) => x !== chosen).map((x) => x.f.name);
        const code: DashboardDecisionCode = c.momentTier === 2 ? "moment-not-null" : tier1.length > 1 ? "moment-several" : "moment-default-now";
        entry.reason = dashboardDecision(code, language, { column: f.name }, c.detail);
        if (alternatives.length) entry.alternatives = alternatives;
      } else {
        entry.role = "discarded";
        entry.reason = dashboardDecision("moment-alternative", language, { column: f.name, moment: chosen!.f.name }, c.detail);
        entry.alternatives = [chosen!.f.name];
      }
    }
    if (f.origin) entry.origin = f.origin;
    if (c.aggregate) entry.aggregate = c.aggregate;
    if (c.values) entry.values = c.values;
    if (c.references) entry.references = c.references;
    if (c.missing) missing.push(dashboardDecision(c.code, language, { column: f.name, target: c.references ?? "" }, c.detail));
    return entry;
  });
  if (!chosen) missing.unshift(dashboardDecision("no-moment", language));
  return { analysis, missing };
}

// --- Proposal -----------------------------------------------------------------

const TEXTS: Record<DashboardDecisionLanguage, Record<string, string>> = {
  en: {
    count: "Count of {table}",
    share: "{column} (%)",
    sum: "Total {column}",
    average: "Average {column}",
    trend: "{table} over time",
    trendMeasure: "{column} over time",
    heatmap: "{table} by weekday and hour",
    calendar: "{table} per day",
    donut: "Count by {column}",
    ranking: "Top 10 by {column}",
    map: "{table} on the map",
    table: "Latest {table}",
    period: "Period",
    description: "Proposed from {relation}.",
  },
  es: {
    count: "Cantidad de {table}",
    share: "{column} (%)",
    sum: "Total de {column}",
    average: "Promedio de {column}",
    trend: "{table} en el tiempo",
    trendMeasure: "{column} en el tiempo",
    heatmap: "{table} por día y hora",
    calendar: "{table} por día",
    donut: "Cantidad por {column}",
    ranking: "Primeros 10 por {column}",
    map: "{table} en el mapa",
    table: "Últimos registros de {table}",
    period: "Período",
    description: "Propuesto a partir de {relation}.",
  },
};

/** A result column's name per language - what a tooltip, a legend and a download read. */
const ALIASES: Record<DashboardDecisionLanguage, Record<string, string>> = {
  en: { count: "count", previous: "previous", share: "percent", sum: "total", average: "average", date: "date", weekday: "weekday", hour: "hour", day: "day" },
  es: { count: "cantidad", previous: "anterior", share: "porcentaje", sum: "total", average: "promedio", date: "fecha", weekday: "día", hour: "hora", day: "día" },
};

const WEEKDAYS: Record<DashboardDecisionLanguage, string[]> = {
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  es: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"],
};

function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export interface ProposeInput {
  relation: SuggestRelation;
  columns: readonly SuggestColumnFacts[];
  analysis: readonly DashboardColumnAnalysis[];
  /** users' single-column foreign keys: its column, and the table it points at. */
  viewerLinks: readonly { field: string; targetOid: number }[];
}

type SecurityMode = { key: "openOnViewers" | "onlyViewers"; column: string; field: string } | null;

interface Built {
  spec: DashboardSpec;
  more: DashboardSpecWidget[];
  reasons: DashboardSuggestionReason[];
}

/** A variable's name from a column's: lowercase letters, digits and _, starting with a letter, at most 32, unique. */
function variableName(column: string, taken: Set<string>): string {
  let base = column.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `v_${base}`;
  base = base.slice(0, 28) || "v";
  let name = base;
  for (let i = 2; taken.has(name) || name === "tab"; i += 1) name = `${base}_${i}`;
  taken.add(name);
  return name;
}

/** A target row's label as SQL over alias `d`: its row presentation's template or field, else the suggested field, else its key. */
function targetLabelSql(target: SuggestForeignKeyTarget, alias: string): string {
  const columns = new Set(target.columns);
  const col = (name: string) => `${alias}.${quoteIdentifier(name)}`;
  const template = target.rowPresentation?.displayTemplate?.trim();
  if (template) {
    const parts = template.split(/(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/).filter((p) => p !== "");
    return `(${parts.map((part) => {
      const name = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(part)?.[1];
      return name && columns.has(name) ? `coalesce(${col(name)}::text, '')` : literal(part);
    }).join(" || ")})`;
  }
  const field = [target.rowPresentation?.displayField, target.suggestedDisplayField].find((f): f is string => Boolean(f && columns.has(f)));
  return `${col(field ?? target.key)}::text`;
}

function build(input: ProposeInput, language: DashboardDecisionLanguage, security: SecurityMode): Built {
  const { relation, columns, analysis } = input;
  const texts = TEXTS[language];
  const facts = new Map(columns.map((f) => [f.name, f]));
  const label = (name: string) => facts.get(name)?.presentation.label?.trim() || mechanicalLabel(name);
  const tableLabel = mechanicalLabel(relation.name);
  const decision = (code: DashboardDecisionCode, params: Record<string, string | number> = {}, detail?: string) => dashboardDecision(code, language, { table: tableLabel, ...params }, detail);
  const q = quoteIdentifier;
  const from = `${q(relation.schema)}.${q(relation.name)} t`;
  const col = (name: string) => `t.${q(name)}`;
  /** A result column's alias - never the name of a column the same query returns, so a role never reads two. */
  const alias = (key: string, beside: readonly string[] = []) => {
    let name = ALIASES[language][key]!;
    while (beside.includes(name)) name = `${name}_n`;
    return name;
  };
  const as = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : q(name));
  const by = (role: SuggestColumnRole) => analysis.filter((a) => a.role === role);

  const moment = by("moment")[0];
  const momentSql = moment ? col(moment.column) : null;
  const reasons: DashboardSuggestionReason[] = [];

  // Variables: the period, then a list per dimension whose target has few rows - chained when one target points at another.
  const variables: DashboardVariable[] = [];
  const taken = new Set<string>(["period"]);
  if (moment) {
    variables.push({ name: "period", label: texts.period!, type: "DATE_RANGE", default: { source: "constant", value: "last_30_days" } });
    reasons.push({ path: `variables[0]`, reason: decision("variable-period", {}, "last_30_days") });
  }
  const lists: { column: string; name: string; target: SuggestForeignKeyTarget; variable: DashboardVariable }[] = [];
  for (const dimension of by("dimension")) {
    const target = facts.get(dimension.column)!.foreignKey!;
    if (security?.key === "onlyViewers" && security.column === dimension.column) continue;
    if (!target.resourceId || target.rows === null || target.rows > LIST_MAX_ROWS) {
      reasons.push({ path: `columns.${dimension.column}`, reason: decision("variable-list-skipped", { column: dimension.column }, target.rows === null ? "reltuples -1" : `reltuples ${target.rows}`) });
      continue;
    }
    const name = variableName(dimension.column, taken);
    const variable: DashboardVariable = { name, label: label(dimension.column), type: "SELECT", options: { source: "TABLE", resource: target.resourceId } };
    if (security?.key === "openOnViewers" && security.column === dimension.column) variable.default = { source: "user", field: security.field };
    lists.push({ column: dimension.column, name, target, variable });
  }
  for (const list of lists) {
    const index = variables.length;
    variables.push(list.variable);
    reasons.push({ path: `variables[${index}]`, reason: decision("variable-list", { column: list.column }, `reltuples ${list.target.rows}`) });
    for (const fk of list.target.foreignKeys) {
      const parent = lists.find((other) => other !== list && other.target.oid === fk.targetOid);
      if (!parent) continue;
      const options = list.variable.options as { source: "TABLE"; resource: string; filters?: { column: string; variable: string }[] };
      options.filters = [...(options.filters ?? []), { column: fk.column, variable: parent.name }];
      reasons.push({ path: `variables[${index}]`, reason: decision("variable-chained", { parent: parent.variable.label }, `${list.target.table}.${fk.column} → ${parent.target.table}`) });
    }
  }

  // Every query's filters: the period, each list, and - when chosen - the viewer's own rows only.
  const periodFilter = momentSql ? [`($VAR.period.from IS NULL OR ${momentSql} >= $VAR.period.from)`, `($VAR.period.to IS NULL OR ${momentSql} < $VAR.period.to)`] : [];
  const listFilters = lists.map((l) => `($VAR.${l.name} IS NULL OR ${col(l.column)}::text = $VAR.${l.name})`);
  // A viewer without one (an administrator, a supervisor) sees every row - as a row filter on $USER does (DB43).
  const securityFilter = security?.key === "onlyViewers" ? [`($USER.${security.field} IS NULL OR ${col(security.column)} = $USER.${security.field})`] : [];
  const where = (extra: string[] = [], period = true) => {
    const all = [...(period ? periodFilter : []), ...listFilters, ...securityFilter, ...extra];
    return all.length ? `\nWHERE ${all.join("\n  AND ")}` : "";
  };

  const spec: DashboardSpecWidget[] = [];
  const more: DashboardSpecWidget[] = [];
  const add = (target: "spec" | "more", widget: DashboardSpecWidget, ...why: DashboardDecision[]) => {
    const list = target === "spec" ? spec : more;
    const index = list.length;
    widget.config = { ...widget.config, description: why[0]!.message.slice(0, 200) };
    list.push(widget);
    for (const reason of why) reasons.push({ path: `${target === "spec" ? "widgets" : "more"}[${index}]`, reason });
  };

  // INDICATORS - how many (against the previous period), each boolean's share, each measure's sum or average.
  const kpis: { widget: DashboardSpecWidget; reason: DashboardDecision }[] = [];
  const count = alias("count");
  if (momentSql) {
    const previous = alias("previous");
    kpis.push({
      widget: {
        type: "KPI",
        label: fill(texts.count!, { table: tableLabel }),
        query: `SELECT count(*) FILTER (WHERE ($VAR.period.from IS NULL OR ${momentSql} >= $VAR.period.from)) AS ${as(count)},
  CASE WHEN $VAR.period.prev_from IS NULL THEN NULL ELSE count(*) FILTER (WHERE ${momentSql} >= $VAR.period.prev_from AND ${momentSql} < $VAR.period.prev_to) END AS ${as(previous)}
FROM ${from}${where([`($VAR.period.prev_from IS NULL OR ${momentSql} >= $VAR.period.prev_from)`, `($VAR.period.to IS NULL OR ${momentSql} < $VAR.period.to)`], false)}`,
        config: { roles: { value: count, compare: previous }, showDelta: true },
      },
      reason: decision("kpi-count"),
    });
  } else {
    kpis.push({ widget: { type: "KPI", label: fill(texts.count!, { table: tableLabel }), query: `SELECT count(*) AS ${as(count)}\nFROM ${from}${where()}`, config: { roles: { value: count } } }, reason: decision("kpi-count-all") });
  }
  for (const entry of analysis) {
    const f = facts.get(entry.column)!;
    if (entry.role === "category" && f.dataType.toLowerCase() === "boolean") {
      const share = alias("share");
      kpis.push({
        widget: {
          type: "KPI",
          label: fill(texts.share!, { column: label(entry.column) }),
          query: `SELECT round(100.0 * count(*) FILTER (WHERE ${col(entry.column)}) / NULLIF(count(*), 0), 1) AS ${as(share)}\nFROM ${from}${where()}`,
          config: { roles: { value: share }, displayFormat: "0.0 %" },
        },
        reason: decision("kpi-share", { column: label(entry.column) }, "boolean"),
      });
    } else if (entry.role === "measure") {
      const sum = entry.aggregate !== "avg";
      const name = alias(sum ? "sum" : "average");
      const format = f.presentation.displayFormat ?? (sum ? undefined : "#,##0.0");
      kpis.push({
        widget: {
          type: "KPI",
          label: fill(sum ? texts.sum! : texts.average!, { column: label(entry.column) }),
          query: `SELECT ${sum ? "sum" : "avg"}(${col(entry.column)}) AS ${as(name)}\nFROM ${from}${where()}`,
          config: { roles: { value: name }, ...(format && { displayFormat: format }) },
        },
        reason: decision(sum ? "kpi-sum" : "kpi-average", { column: label(entry.column) }, f.dataType),
      });
    }
  }
  kpis.forEach((kpi, i) => (i < KPI_TICKED ? add("spec", kpi.widget, kpi.reason) : add("more", kpi.widget, kpi.reason, decision("kpi-limit", {}, `${i + 1} > ${KPI_TICKED}`))));

  // COMPARISON - each dimension's 10 values with the most records, by its target's row presentation.
  for (const dimension of by("dimension")) {
    if (security?.key === "onlyViewers" && security.column === dimension.column) continue;
    const target = facts.get(dimension.column)!.foreignKey!;
    const cnt = alias("count", [dimension.column]);
    add("spec", {
      type: "LEADERBOARD",
      label: fill(texts.ranking!, { column: label(dimension.column) }),
      query: `SELECT ${targetLabelSql(target, "d")} AS ${q(dimension.column)}, count(*) AS ${as(cnt)}
FROM ${from}
JOIN ${q(target.schema)}.${q(target.table)} d ON d.${q(target.key)} = ${col(dimension.column)}${where()}
GROUP BY ${col(dimension.column)}, 1
ORDER BY 2 DESC, 1
LIMIT 10`,
      config: { roles: { category: dimension.column, value: cnt } },
    }, decision("ranking", { column: label(dimension.column) }, `→ ${target.schema}.${target.table}`));
  }

  // TREND - per day, week or month by the period's length, cut in the viewer's time zone (the run's TimeZone).
  const bucket = momentSql
    ? `date_trunc(CASE WHEN $VAR.period.from IS NULL OR $VAR.period.to IS NULL THEN 'month' WHEN $VAR.period.to - $VAR.period.from <= interval '31 days' THEN 'day' WHEN $VAR.period.to - $VAR.period.from <= interval '190 days' THEN 'week' ELSE 'month' END, ${momentSql})::date`
    : null;
  if (bucket && moment) {
    const date = alias("date");
    add("spec", {
      type: "LINE",
      label: fill(texts.trend!, { table: tableLabel }),
      query: `SELECT ${bucket} AS ${as(date)}, count(*) AS ${as(count)}\nFROM ${from}${where()}\nGROUP BY 1\nORDER BY 1`,
      config: { roles: { category: date, values: [count] } },
    }, decision("trend", {}, moment.column));
    for (const measure of by("measure").slice(0, 2)) {
      const f = facts.get(measure.column)!;
      const sum = measure.aggregate !== "avg";
      const value = alias(sum ? "sum" : "average");
      const format = f.presentation.displayFormat ?? (sum ? undefined : "#,##0.0");
      add("more", {
        type: "LINE",
        label: fill(texts.trendMeasure!, { column: label(measure.column) }),
        query: `SELECT ${bucket} AS ${as(date)}, ${sum ? "sum" : "avg"}(${col(measure.column)}) AS ${as(value)}\nFROM ${from}${where()}\nGROUP BY 1\nORDER BY 1`,
        config: { roles: { category: date, values: [value] }, ...(format && { displayFormat: format }) },
      }, decision("trend-measure", { column: label(measure.column) }, `${sum ? "sum" : "avg"}(${measure.column})`));
    }
  }

  // PROPORTION - a donut per category of up to 7 values (not a boolean: its KPI says it), its values' labels and colors.
  for (const category of by("category")) {
    const f = facts.get(category.column)!;
    if (f.dataType.toLowerCase() === "boolean") continue;
    const size = category.values?.length ?? rangeSize(f) ?? distinctValues(f);
    if (size === null || size > DONUT_MAX) continue;
    const cnt = alias("count", [category.column]);
    add("spec", {
      type: "DONUT",
      label: fill(texts.donut!, { column: label(category.column) }),
      query: `SELECT ${col(category.column)}, count(*) AS ${as(cnt)}\nFROM ${from}${where([`${col(category.column)} IS NOT NULL`])}\nGROUP BY 1\nORDER BY 2 DESC`,
      config: { roles: { category: category.column, value: cnt } },
    }, decision("donut-category", { column: label(category.column) }, `${size} values`));
  }

  // DISTRIBUTION - weekday × hour when the time axis has a time of day; a calendar for long periods, unticked.
  if (momentSql && moment && TIMESTAMP.test(facts.get(moment.column)!.dataType.toLowerCase())) {
    const weekday = alias("weekday");
    const hour = alias("hour");
    const dow = `extract(isodow FROM ${momentSql})`;
    add("spec", {
      type: "HEATMAP",
      label: fill(texts.heatmap!, { table: tableLabel }),
      query: `SELECT (ARRAY[${WEEKDAYS[language].map(literal).join(", ")}])[${dow}::int] AS ${as(weekday)}, extract(hour FROM ${momentSql})::int AS ${as(hour)}, count(*) AS ${as(count)}
FROM ${from}${where()}
GROUP BY ${dow}, 2
ORDER BY ${dow}, 2`,
      config: { roles: { x: hour, y: weekday, value: count } },
    }, decision("heatmap-weekday-hour", {}, facts.get(moment.column)!.dataType));
  }
  if (momentSql && moment) {
    const day = alias("day");
    add("more", {
      type: "CALENDAR",
      label: fill(texts.calendar!, { table: tableLabel }),
      query: `SELECT ${momentSql}::date AS ${as(day)}, count(*) AS ${as(count)}\nFROM ${from}${where()}\nGROUP BY 1\nORDER BY 1`,
      config: { roles: { date: day, value: count } },
    }, decision("calendar", {}, moment.column));
  }

  // MAPS - the records at their place.
  const place = by("place")[0];
  if (place) {
    add("spec", {
      type: "MAP",
      label: fill(texts.map!, { table: tableLabel }),
      query: `SELECT ${col(place.column)}\nFROM ${from}${where([`${col(place.column)} IS NOT NULL`])}\nLIMIT 1000`,
      config: { roles: { location: place.column } },
    }, decision("map-place", { column: label(place.column) }, place.column));
  }

  // TABLES - the latest 20 records: the time axis, then each category, dimension (its row's label), measure and file.
  const shown = analysis.filter((a) => ["category", "dimension", "measure", "file"].includes(a.role)).slice(0, 9);
  if (moment || shown.length > 0) {
    const select: string[] = [];
    const joins: string[] = [];
    const names: string[] = [];
    if (moment) {
      select.push(col(moment.column));
      names.push(moment.column);
    }
    shown.forEach((entry, i) => {
      if (entry.role === "dimension") {
        const target = facts.get(entry.column)!.foreignKey!;
        const d = `d${i + 1}`;
        joins.push(`LEFT JOIN ${q(target.schema)}.${q(target.table)} ${d} ON ${d}.${q(target.key)} = ${col(entry.column)}`);
        select.push(`${targetLabelSql(target, d)} AS ${q(entry.column)}`);
      } else {
        select.push(col(entry.column));
      }
      names.push(entry.column);
    });
    const key = analysis.find((a) => a.reason.code === "identifier-primary-key");
    const order = moment ? `\nORDER BY ${col(moment.column)} DESC` : key ? `\nORDER BY ${col(key.column)} DESC` : "";
    add("spec", {
      type: "TABLE",
      label: fill(texts.table!, { table: tableLabel }),
      query: `SELECT ${select.join(", ")}\nFROM ${from}${joins.length ? `\n${joins.join("\n")}` : ""}${where()}${order}\nLIMIT 20`,
      config: { roles: { columns: names } },
    }, decision("table-latest", {}, by("file")[0] ? `${names.length} columns, ${by("file")[0]!.column} as a thumbnail` : `${names.length} columns`));
  }

  return {
    spec: {
      name: tableLabel.slice(0, 32),
      description: fill(texts.description!, { relation: `${relation.schema}.${relation.name}` }).slice(0, 128),
      icon: "i-lucide-layout-dashboard",
      variables,
      widgets: spec,
    },
    more,
    reasons,
  };
}

function rangeSize(f: SuggestColumnFacts): number | null {
  const range = integerRange(f.checkName, f.dataType.toLowerCase(), f.checks);
  return range ? range.max - range.min + 1 : null;
}

/**
 * The proposed dashboard (D27 §3-5): grouped as the widget bar - KPIs (at most 4 ticked, by position), a ranking per
 * dimension, the trend, a donut per small category, weekday × hour, the map, the latest records - with a period and
 * a list per small dimension; what's offered unticked in `more`; and, when users points at a dimension's
 * table, the two ways to filter by who views it, each a whole alternative spec.
 */
export function proposeDashboard(input: ProposeInput, language: DashboardDecisionLanguage): Pick<DashboardSuggestion, "spec" | "more" | "reasons" | "security"> {
  const base = build(input, language, null);
  const tableLabel = mechanicalLabel(input.relation.name);
  const options: DashboardSecurityOption[] = [];
  for (const dimension of input.analysis.filter((a) => a.role === "dimension")) {
    const target = input.columns.find((f) => f.name === dimension.column)!.foreignKey!;
    for (const link of input.viewerLinks.filter((l) => l.targetOid === target.oid)) {
      const params = { column: dimension.column, field: link.field };
      const detail = `totalbase.users.${link.field} → ${target.schema}.${target.table}`;
      const open = build(input, language, { key: "openOnViewers", column: dimension.column, field: link.field });
      // Opening on the viewer's value needs the dimension's list.
      if (open.spec.variables?.some((v) => v.default?.source === "user")) {
        options.push({ key: "openOnViewers", column: dimension.column, field: link.field, reason: dashboardDecision("security-open-on-viewer", language, params, detail), spec: open.spec, more: open.more });
      }
      const only = build(input, language, { key: "onlyViewers", column: dimension.column, field: link.field });
      options.push({ key: "onlyViewers", column: dimension.column, field: link.field, reason: dashboardDecision("security-only-viewer", language, params, detail), spec: only.spec, more: only.more });
    }
  }
  return {
    ...base,
    security: { notice: dashboardDecision("security-all-rows", language, { table: tableLabel }, `${input.relation.schema}.${input.relation.name}`), options },
  };
}

// --- Reading the catalog ------------------------------------------------------

interface AttributeFacts {
  typeKind: "base" | "enum" | "domain";
  baseType: string | null;
  typeValues: string[] | null;
  stats: { nDistinct: number; nullFrac: number } | null;
}

interface RelationFacts {
  oid: number;
  schema: string;
  name: string;
  relkind: string;
  rows: number | null;
  detail: RelationDetail;
  attributes: Map<string, AttributeFacts>;
}

/**
 * Builds the analysis's input from the catalog: pg_class, pg_attribute, pg_type, pg_constraint, pg_stats and the
 * TotalBase resource and presentation tables - never the table itself.
 */
class CatalogReader {
  private relations = new Map<number, Promise<RelationFacts>>();
  private targets = new Map<string, Promise<SuggestForeignKeyTarget | null>>();

  constructor(private readonly database: Database) {}

  relation(oid: number): Promise<RelationFacts> {
    let facts = this.relations.get(oid);
    if (!facts) {
      facts = this.loadRelation(oid);
      this.relations.set(oid, facts);
    }
    return facts;
  }

  private async loadRelation(oid: number): Promise<RelationFacts> {
    const [{ rows: classRows }, detail, { rows: attrs }] = await Promise.all([
      this.database.query<{ schema: string; name: string; relkind: string; reltuples: number }>(
        `SELECT n.nspname AS "schema", c.relname AS name, c.relkind::text AS relkind, c.reltuples
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1`,
        [oid],
      ),
      getRelationDetail(this.database, oid),
      this.database.query<{ name: string; typtype: string; base_type: string | null; enum_values: string[] | null; domain_checks: string[] | null; n_distinct: number | null; null_frac: number | null }>(
        `SELECT a.attname AS name, t.typtype::text AS typtype,
                CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END AS base_type,
                CASE WHEN t.typtype = 'e' THEN ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) END AS enum_values,
                CASE WHEN t.typtype = 'd' THEN ARRAY(SELECT pg_catalog.pg_get_constraintdef(dc.oid) FROM pg_catalog.pg_constraint dc WHERE dc.contypid = t.oid AND dc.contype = 'c') END AS domain_checks,
                s.n_distinct, s.null_frac
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN LATERAL (
             SELECT st.n_distinct, st.null_frac FROM pg_catalog.pg_stats st
              WHERE st.schemaname = n.nspname AND st.tablename = c.relname AND st.attname = a.attname
              ORDER BY st.inherited LIMIT 1
           ) s ON true
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped`,
        [oid],
      ),
    ]);
    const row = classRows[0]!;
    const attributes = new Map<string, AttributeFacts>();
    for (const a of attrs) {
      const typeKind = a.typtype === "e" ? "enum" : a.typtype === "d" ? "domain" : "base";
      const domainValues = a.domain_checks ? checkConstraintValues("value", a.domain_checks.map((c) => c.replace(/\bVALUE\b/g, "value"))) : null;
      attributes.set(a.name, {
        typeKind,
        baseType: a.base_type,
        typeValues: typeKind === "enum" ? a.enum_values : typeKind === "domain" ? domainValues : null,
        stats: a.n_distinct === null ? null : { nDistinct: Number(a.n_distinct), nullFrac: Number(a.null_frac ?? 0) },
      });
    }
    const reltuples = Number(row.reltuples);
    return { oid, schema: row.schema, name: row.name, relkind: row.relkind, rows: reltuples >= 0 ? reltuples : null, detail, attributes };
  }

  target(schema: string, table: string, key: string): Promise<SuggestForeignKeyTarget | null> {
    const id = `${schema}.${table}.${key}`;
    let target = this.targets.get(id);
    if (!target) {
      target = this.loadTarget(schema, table, key);
      this.targets.set(id, target);
    }
    return target;
  }

  private async loadTarget(schema: string, table: string, key: string): Promise<SuggestForeignKeyTarget | null> {
    const { rows } = await this.database.query<{ oid: number; resource: string | null; row_presentation: RowPresentation | null }>(
      `SELECT c.oid::int AS oid, r.id AS resource, r.row_presentation
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN totalbase.resources r ON r.postgres_oid = c.oid AND r.status = 'ACTIVE' AND r.type = 'TABLE'
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );
    const row = rows[0];
    if (!row) return null;
    const facts = await this.relation(row.oid);
    const { rows: fks } = await this.database.query<{ column: string; target: number }>(
      `SELECT a.attname AS "column", con.confrelid::int AS target
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
        WHERE con.conrelid = $1 AND con.contype = 'f' AND cardinality(con.conkey) = 1`,
      [row.oid],
    );
    const presentation = row.row_presentation && (row.row_presentation.displayField || row.row_presentation.displayTemplate) ? row.row_presentation : null;
    const suggested = presentation ? null : suggestPresentation({ detail: facts.detail, comments: {}, current: {}, inherited: new Set(), row: null, isView: false }).row?.displayField ?? null;
    return {
      oid: row.oid,
      schema,
      table,
      key,
      resourceId: row.resource,
      rows: facts.rows,
      rowPresentation: presentation,
      suggestedDisplayField: suggested,
      columns: facts.detail.columns.map((c) => c.name),
      foreignKeys: fks.map((fk) => ({ column: fk.column, targetOid: Number(fk.target) })),
    };
  }

  /** A column of a table (or the table column a view's column is) as the analysis reads it. */
  async columnFacts(oid: number, column: string, name: string, presentation: SuggestColumnFacts["presentation"], origin?: string | null): Promise<SuggestColumnFacts | null> {
    const relation = await this.relation(oid);
    const definition = relation.detail.columns.find((c) => c.name === column);
    if (!definition) return null;
    const attribute = relation.attributes.get(column);
    const fk = relation.detail.relations.find((r) => r.sourceColumn === column);
    const fileReference = fk?.targetSchema === "totalbase" && fk.targetTable === "files";
    const uniqueSingle = relation.detail.uniqueConstraints.some((set) => set.length === 1 && set[0] === column);
    return {
      name,
      dataType: attribute?.typeKind === "domain" && attribute.baseType ? attribute.baseType : definition.dataType,
      nullable: definition.nullable,
      isIdentity: definition.isIdentity,
      isGenerated: definition.isGenerated,
      defaultExpression: definition.defaultExpression,
      typeKind: attribute?.typeKind ?? "base",
      typeValues: attribute?.typeValues ?? null,
      primaryKey: relation.detail.primaryKey.length === 1 && relation.detail.primaryKey[0] === column,
      unique: uniqueSingle,
      checks: relation.detail.checkConstraints.map((c) => ({ expression: c.expression, message: c.message })),
      checkName: column,
      foreignKey: fk && !fileReference ? await this.target(fk.targetSchema, fk.targetTable, fk.targetColumn) : null,
      fileReference,
      stats: attribute?.stats ?? null,
      relationRows: relation.rows,
      ...(origin !== undefined && { origin }),
      presentation,
    };
  }
}

/** A view's column → the table column it is, through views over views (view_column_origins). */
async function viewOrigins(database: Database, reader: CatalogReader, viewOid: number): Promise<Map<string, { oid: number; column: string }>> {
  const origins = new Map<string, { oid: number; column: string }>();
  const { rows } = await database.query<{ name: string; origin: number; origin_name: string }>(
    `SELECT a.attname AS name, o.origin_relid::int AS origin, sa.attname AS origin_name
       FROM totalbase.view_column_origins($1) o
       JOIN pg_catalog.pg_attribute a ON a.attrelid = $1 AND a.attnum = o.attnum
       JOIN pg_catalog.pg_attribute sa ON sa.attrelid = o.origin_relid AND sa.attnum = o.origin_attnum`,
    [viewOid],
  );
  for (const row of rows) {
    let origin = { oid: Number(row.origin), column: row.origin_name };
    // A view over a view: follow it to the table, at most a few levels.
    for (let depth = 0; depth < 5; depth += 1) {
      const relation = await reader.relation(origin.oid);
      if (relation.relkind !== "v" && relation.relkind !== "m") break;
      const next = (await viewOrigins(database, reader, origin.oid)).get(origin.column);
      if (!next) break;
      origin = next;
    }
    origins.set(row.name, origin);
  }
  return origins;
}

/**
 * suggest_dashboard (D27): reads `schema.name` - a table or a view - from the catalog and proposes a dashboard for it.
 * Unknown: RESOURCE_NOT_FOUND. `language` is the App's (`system.language`) - the messages', the titles' and the
 * result columns' language; codes and details never change with it.
 */
export async function suggestDashboard(database: Database, input: { name: string; schema?: string | null | undefined; language?: unknown }): Promise<DashboardSuggestion> {
  const language = decisionLanguage(input.language);
  const schema = input.schema?.trim() || "public";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const { rows } = await database.query<{ oid: number; relkind: string; resource: string | null }>(
    `SELECT c.oid::int AS oid, c.relkind::text AS relkind,
            (SELECT r.id FROM totalbase.resources r WHERE r.postgres_oid = c.oid AND r.status = 'ACTIVE' LIMIT 1) AS resource
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm')`,
    [schema, name],
  );
  const found = rows[0];
  if (!found) throw new TotalBaseError("RESOURCE_NOT_FOUND", `No table or view ${schema}.${name}.`);
  const oid = Number(found.oid);
  const isView = found.relkind === "v" || found.relkind === "m";
  const reader = new CatalogReader(database);
  const relation = await reader.relation(oid);

  const presentations: Record<string, Record<string, unknown>> = found.resource
    ? ((await database.query<{ p: Record<string, Record<string, unknown>> }>(`SELECT totalbase.resource_column_presentation($1) AS p`, [found.resource])).rows[0]?.p ?? {})
    : {};
  const presentationOf = (column: string): SuggestColumnFacts["presentation"] => {
    const p = presentations[column] ?? {};
    return {
      ...(typeof p.label === "string" && { label: p.label }),
      ...(typeof p.displayFormat === "string" && { displayFormat: p.displayFormat }),
      ...(typeof p.options === "object" && p.options !== null && { options: p.options as NonNullable<ColumnPresentation["options"]> }),
    };
  };

  const origins = isView ? await viewOrigins(database, reader, oid) : new Map<string, { oid: number; column: string }>();
  const columns: SuggestColumnFacts[] = [];
  for (const definition of relation.detail.columns) {
    const presentation = presentationOf(definition.name);
    if (!isView) {
      columns.push((await reader.columnFacts(oid, definition.name, definition.name, presentation))!);
      continue;
    }
    const origin = origins.get(definition.name);
    const originRelation = origin ? await reader.relation(origin.oid) : null;
    const facts = origin && originRelation ? await reader.columnFacts(origin.oid, origin.column, definition.name, presentation, `${originRelation.schema}.${originRelation.name}.${origin.column}`) : null;
    columns.push(
      facts ?? {
        name: definition.name,
        dataType: definition.dataType,
        nullable: definition.nullable,
        isIdentity: false,
        isGenerated: false,
        defaultExpression: null,
        typeKind: "base",
        typeValues: null,
        primaryKey: false,
        unique: false,
        checks: [],
        checkName: definition.name,
        foreignKey: null,
        fileReference: false,
        stats: null,
        relationRows: null,
        origin: null,
        presentation,
      },
    );
  }

  const { rows: links } = await database.query<{ field: string; target: number }>(
    `SELECT a.attname AS field, con.confrelid::int AS target
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.conrelid = 'totalbase.users'::regclass AND con.contype = 'f' AND cardinality(con.conkey) = 1`,
  );
  const viewerLinks = links.filter((l) => /^[a-z_][a-z0-9_]*$/.test(l.field)).map((l) => ({ field: l.field, targetOid: Number(l.target) }));

  const suggestionRelation: SuggestRelation = { schema: relation.schema, name: relation.name, type: isView ? "VIEW" : "TABLE", resourceId: found.resource };
  const { analysis, missing } = analyzeColumns(columns, language);
  const proposal = proposeDashboard({ relation: suggestionRelation, columns, analysis, viewerLinks }, language);
  return { relation: suggestionRelation, analysis, ...proposal, missing };
}
