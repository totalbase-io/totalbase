import { readFileSync } from "node:fs";
import { DASHBOARD_DECISION_CODES, isDashboardDecisionCode, isDashboardWidgetType, validateDashboardWidgetConfig } from "@totalbase/tb-catalog";
import { describe, expect, it } from "vitest";
import { analyzeColumns, proposeDashboard, type SuggestColumnFacts, type SuggestForeignKeyTarget } from "./dashboard-suggest.js";
import type { DashboardSpec, DashboardSpecWidget } from "./dashboard-spec.js";
import { listSqlVariableRefs } from "./sql-variables.js";
import { validateVariables } from "./variables.js";

const BRANCHES: SuggestForeignKeyTarget = {
  oid: 1001,
  schema: "public",
  table: "branches",
  key: "id",
  resourceId: "00000000-0000-4000-8000-000000000001",
  rows: 4,
  rowPresentation: { displayField: "name" },
  suggestedDisplayField: null,
  columns: ["id", "name"],
  foreignKeys: [],
};
const SELF_EXCLUSIONS: SuggestForeignKeyTarget = { ...BRANCHES, oid: 1002, table: "self_exclusions", resourceId: "00000000-0000-4000-8000-000000000002", rows: 5000, rowPresentation: null, suggestedDisplayField: "document" };

const CHECKS = [
  { expression: "CHECK ((format = ANY (ARRAY['DNI'::text, 'PASSPORT'::text, 'OTHER'::text])))", message: null },
  { expression: "CHECK (((hour >= 0) AND (hour <= 23)))", message: null },
  { expression: "CHECK (((weekday >= 1) AND (weekday <= 7)))", message: null },
];

function column(name: string, dataType: string, more: Partial<SuggestColumnFacts> = {}): SuggestColumnFacts {
  return {
    name,
    dataType,
    nullable: true,
    isIdentity: false,
    isGenerated: false,
    defaultExpression: null,
    typeKind: "base",
    typeValues: null,
    primaryKey: false,
    unique: false,
    checks: CHECKS,
    checkName: name,
    foreignKey: null,
    fileReference: false,
    stats: { nDistinct: 10, nullFrac: 0 },
    relationRows: 1000,
    presentation: {},
    ...more,
  };
}

/** The lab's readings (`lecturas`), by type and constraint only. */
const READINGS: SuggestColumnFacts[] = [
  column("id", "bigint", { primaryKey: true, nullable: false, isIdentity: true, stats: { nDistinct: -1, nullFrac: 0 } }),
  column("taken_at", "timestamp with time zone", { nullable: false, defaultExpression: "now()", stats: { nDistinct: -1, nullFrac: 0 } }),
  column("received_at", "timestamp with time zone", { nullable: false, defaultExpression: "now()", stats: { nDistinct: -1, nullFrac: 0 } }),
  column("branch", "uuid", { foreignKey: BRANCHES, nullable: false }),
  column("format", "text", { nullable: false }),
  column("is_dni", "boolean", { stats: { nDistinct: 2, nullFrac: 0 } }),
  column("minor", "boolean", { stats: { nDistinct: 2, nullFrac: 0 } }),
  column("hour", "smallint", { stats: { nDistinct: 24, nullFrac: 0 } }),
  column("weekday", "smallint", { stats: { nDistinct: 7, nullFrac: 0 } }),
  column("age", "integer", { stats: { nDistinct: 67, nullFrac: 0.1 }, presentation: { label: "Age", displayFormat: "0 \"y\"" } }),
  column("device", "uuid", { stats: { nDistinct: 20, nullFrac: 0 } }),
  column("sex", "text", { stats: { nDistinct: 3, nullFrac: 0 } }),
  column("age_range", "text", { isGenerated: true, stats: null }),
  column("exclusion", "uuid", { foreignKey: SELF_EXCLUSIONS, stats: null }),
  column("photo", "uuid", { fileReference: true }),
  column("visits", "integer", { stats: null }),
  column("location", "point"),
];

const byColumn = (analysis: { column: string }[]) => new Map(analysis.map((a) => [a.column, a] as const)) as Map<string, ReturnType<typeof analyzeColumns>["analysis"][number]>;

describe("analyzeColumns (D27)", () => {
  it("reads each column's role from its type, constraints and statistics", () => {
    const { analysis, missing } = analyzeColumns(READINGS, "en");
    const by = byColumn(analysis);
    const role = (name: string) => [by.get(name)!.role, by.get(name)!.reason.code];
    expect(role("id")).toEqual(["identifier", "identifier-primary-key"]);
    expect(role("taken_at")).toEqual(["moment", "moment-several"]);
    expect(by.get("taken_at")!.alternatives).toEqual(["received_at"]);
    expect(role("received_at")).toEqual(["discarded", "moment-alternative"]);
    expect(role("branch")).toEqual(["dimension", "dimension-foreign-key"]);
    expect(role("format")).toEqual(["category", "category-check-list"]);
    expect(by.get("format")!.values).toEqual(["DNI", "PASSPORT", "OTHER"]);
    expect(role("is_dni")).toEqual(["category", "category-boolean"]);
    expect(role("hour")).toEqual(["category", "category-check-range"]);
    expect(by.get("hour")!.reason.detail).toBe("CHECK 0..23");
    expect(role("weekday")).toEqual(["category", "category-check-range"]);
    expect(role("age")).toEqual(["measure", "measure-integer-many"]);
    expect(by.get("age")!.aggregate).toBe("avg");
    expect(role("device")).toEqual(["discarded", "uuid-without-fk"]);
    expect(role("sex")).toEqual(["discarded", "text-without-check"]);
    expect(role("age_range")).toEqual(["discarded", "text-without-check"]);
    expect(role("exclusion")).toEqual(["dimension", "dimension-suggested-presentation"]);
    expect(role("photo")).toEqual(["file", "file-reference"]);
    expect(role("visits")).toEqual(["measure", "no-stats"]);
    expect(role("location")).toEqual(["place", "place-point"]);
    expect(missing.map((m) => m.code)).toEqual(["uuid-without-fk", "text-without-check", "text-without-check", "dimension-suggested-presentation", "no-stats"]);
    expect(missing[0]!.message).toContain('"device"');
  });

  it("an integer with 2 to 31 distinct values is a category, with more a measure; a single value is left out", () => {
    const { analysis } = analyzeColumns(
      [
        column("a", "integer", { checks: [], stats: { nDistinct: 31, nullFrac: 0 } }),
        column("b", "integer", { checks: [], stats: { nDistinct: 32, nullFrac: 0 } }),
        column("c", "boolean", { stats: { nDistinct: 1, nullFrac: 0 } }),
        column("d", "text", { stats: { nDistinct: 0, nullFrac: 1 } }),
        column("e", "numeric(12,2)", { checks: [] }),
        column("f", "text", { checks: [], stats: { nDistinct: -0.8, nullFrac: 0 } }),
        column("g", "date", { nullable: false, defaultExpression: "(CURRENT_DATE + 30)" }),
      ],
      "en",
    );
    expect(analysis.map((a) => [a.column, a.role, a.reason.code])).toEqual([
      ["a", "category", "category-few-values"],
      ["b", "measure", "measure-integer-many"],
      ["c", "discarded", "single-value"],
      ["d", "discarded", "single-value"],
      ["e", "measure", "measure-numeric"],
      ["f", "identifier", "identifier-free-text"],
      ["g", "deadline", "deadline-future-default"],
    ]);
  });

  it("takes the first required date when none defaults to now - and says when there is none", () => {
    const visits = analyzeColumns([column("id", "integer", { primaryKey: true }), column("entered_at", "timestamp without time zone", { nullable: false }), column("left_at", "timestamp without time zone")], "en");
    expect(byColumn(visits.analysis).get("entered_at")!.reason.code).toBe("moment-not-null");
    expect(byColumn(visits.analysis).get("left_at")!.reason.code).toBe("date-other");
    expect(analyzeColumns([column("n", "numeric")], "en").missing[0]!.code).toBe("no-moment");
  });

  it("is the same with the columns renamed, and the same codes and details in every language", () => {
    const renamed = READINGS.map((f, i) => ({ ...f, name: `c${i}_${f.name.length}`, checkName: `c${i}_${f.name.length}`, checks: f.checks.map((c) => ({ ...c, expression: c.expression.replace(new RegExp(`\\b${f.name}\\b`, "g"), `c${i}_${f.name.length}`) })) }));
    const strip = (a: { role: string; reason: { code: string } }[]) => a.map((x) => [x.role, x.reason.code]);
    expect(strip(analyzeColumns(renamed, "en").analysis)).toEqual(strip(analyzeColumns(READINGS, "en").analysis));
    const en = analyzeColumns(READINGS, "en").analysis;
    const es = analyzeColumns(READINGS, "es").analysis;
    expect(es.map((a) => [a.reason.code, a.reason.detail])).toEqual(en.map((a) => [a.reason.code, a.reason.detail]));
    expect(es.find((a) => a.column === "taken_at")!.reason.message).not.toBe(en.find((a) => a.column === "taken_at")!.reason.message);
  });

  it("a view's computed column is a measure when it's a number, else left out", () => {
    const { analysis } = analyzeColumns([column("total", "numeric", { origin: null }), column("label", "text", { origin: null }), column("taken_at", "timestamp with time zone", { origin: "public.readings.taken_at", nullable: false, defaultExpression: "now()" })], "en");
    expect(analysis.map((a) => [a.role, a.reason.code, a.origin])).toEqual([
      ["measure", "view-computed", undefined],
      ["discarded", "view-computed", undefined],
      ["moment", "moment-default-now", "public.readings.taken_at"],
    ]);
  });
});

describe("proposeDashboard (D27)", () => {
  const relation = { schema: "public", name: "readings", type: "TABLE" as const, resourceId: null };
  const propose = (columns: SuggestColumnFacts[], viewerLinks: { field: string; targetOid: number }[] = [], language: "en" | "es" = "en") =>
    proposeDashboard({ relation, columns, analysis: analyzeColumns(columns, language).analysis, viewerLinks }, language);

  /** Every widget's config passes the catalog's check, every role is set, every $VAR it reads exists. */
  function expectValid(spec: DashboardSpec, more: DashboardSpecWidget[] = []) {
    validateVariables(spec.variables ?? []);
    const names = new Set((spec.variables ?? []).map((v) => v.name));
    for (const widget of [...spec.widgets, ...more]) {
      expect(isDashboardWidgetType(widget.type)).toBe(true);
      expect(validateDashboardWidgetConfig(widget.type as never, widget.config), widget.type).toEqual([]);
      expect(Object.keys((widget.config?.roles as object) ?? {}).length, `${widget.type} sets its roles`).toBeGreaterThan(0);
      expect(typeof widget.config?.description).toBe("string");
      for (const ref of listSqlVariableRefs(widget.query!)) if (ref.kind === "VAR") expect(names.has(ref.name), `${widget.type} reads $VAR.${ref.name}`).toBe(true);
    }
  }

  it("proposes KPIs (4 ticked), a ranking, the trend, donuts, a heatmap, a map and the latest records", () => {
    const { spec, more, reasons, security } = propose(READINGS);
    expectValid(spec, more);
    expect(spec.widgets.map((w) => w.type)).toEqual(["KPI", "KPI", "KPI", "KPI", "LEADERBOARD", "LEADERBOARD", "LINE", "DONUT", "DONUT", "HEATMAP", "MAP", "TABLE"]);
    // count, is_dni %, minor %, age's average ticked; visits' average offered.
    expect(more.map((w) => w.type)).toEqual(["KPI", "LINE", "LINE", "CALENDAR"]);
    expect(reasons.filter((r) => r.path === "more[0]").map((r) => r.reason.code)).toEqual(["kpi-average", "kpi-limit"]);
    // The age KPI inherits its column's format; the count compares with the previous period.
    expect(spec.widgets[3]!.config).toMatchObject({ roles: { value: "average" }, displayFormat: "0 \"y\"" });
    expect(spec.widgets[0]!.query).toContain("$VAR.period.prev_from");
    expect(spec.widgets[0]!.config).toMatchObject({ roles: { value: "count", compare: "previous" }, showDelta: true });
    // The heatmap: weekday × hour from the time axis.
    expect(spec.widgets[9]!.config!.roles).toEqual({ x: "hour", y: "weekday", value: "count" });
    // A list for the small dimension only; the large one says why not.
    expect(spec.variables!.map((v) => [v.name, v.type])).toEqual([["period", "DATE_RANGE"], ["branch", "SELECT"]]);
    expect(spec.variables![1]!.options).toEqual({ source: "TABLE", resource: BRANCHES.resourceId });
    expect(reasons.find((r) => r.path === "columns.exclusion")!.reason.code).toBe("variable-list-skipped");
    // Ranking by the target's row presentation.
    expect(spec.widgets[4]!.query).toContain(`d."name"::text AS "branch"`);
    expect(security.notice.code).toBe("security-all-rows");
    expect(security.options).toEqual([]);
    for (const reason of reasons) expect(isDashboardDecisionCode(reason.reason.code)).toBe(true);
  });

  it("offers to filter by who views it when users points at a dimension's table", () => {
    const { security } = propose(READINGS, [{ field: "branch_id", targetOid: BRANCHES.oid }]);
    expect(security.options.map((o) => [o.key, o.column, o.field, o.reason.code])).toEqual([
      ["openOnViewers", "branch", "branch_id", "security-open-on-viewer"],
      ["onlyViewers", "branch", "branch_id", "security-only-viewer"],
    ]);
    const [open, only] = security.options;
    expectValid(open!.spec, open!.more);
    expectValid(only!.spec, only!.more);
    expect(open!.spec.variables!.find((v) => v.name === "branch")!.default).toEqual({ source: "user", field: "branch_id" });
    // Only the viewer's: no list for it, every query filtered by $USER.
    expect(only!.spec.variables!.map((v) => v.name)).toEqual(["period"]);
    // A viewer without a branch (an administrator, a supervisor) sees every row (DB43).
    for (const widget of [...only!.spec.widgets, ...only!.more]) expect(widget.query).toContain(`($USER.branch_id IS NULL OR t."branch" = $USER.branch_id)`);
    expect(only!.reason.message).toContain("whoever has no branch_id sees every row");
  });

  it("chains a list whose target points at another list's target", () => {
    const countries: SuggestForeignKeyTarget = { ...BRANCHES, oid: 2001, table: "countries", resourceId: "00000000-0000-4000-8000-000000000003" };
    const cities: SuggestForeignKeyTarget = { ...BRANCHES, oid: 2002, table: "cities", resourceId: "00000000-0000-4000-8000-000000000004", foreignKeys: [{ column: "country", targetOid: 2001 }] };
    const { spec, reasons } = propose([column("at", "date", { nullable: false, defaultExpression: "CURRENT_DATE" }), column("city", "integer", { foreignKey: cities }), column("country", "integer", { foreignKey: countries })]);
    expectValid(spec);
    expect(spec.variables!.find((v) => v.name === "city")!.options).toEqual({ source: "TABLE", resource: cities.resourceId, filters: [{ column: "country", variable: "country" }] });
    expect(reasons.some((r) => r.reason.code === "variable-chained")).toBe(true);
    // A date with no time of day: no heatmap.
    expect(spec.widgets.some((w) => w.type === "HEATMAP")).toBe(false);
  });

  it("titles in the App's language, the result columns too", () => {
    const { spec } = propose(READINGS, [], "es");
    expect(spec.widgets[0]).toMatchObject({ label: "Cantidad de Readings", config: { roles: { value: "cantidad", compare: "anterior" } } });
    expect(spec.variables![0]!.label).toBe("Período");
  });
});

describe("decision codes (DM3)", () => {
  it("every code the assistant emits is in DASHBOARD_DECISION_CODES", () => {
    const source = readFileSync(new URL("./dashboard-suggest.ts", import.meta.url), "utf8");
    const codes = new Set<string>();
    // Every kebab-case literal (but an icon's name), and each single word a decision is made with.
    for (const match of source.matchAll(/"([a-z]+(?:-[a-z]+)+)"/g)) if (!match[1]!.startsWith("i-lucide-")) codes.add(match[1]!);
    for (const match of source.matchAll(/(?:decision|dashboardDecision)\("([a-z]+)"/g)) codes.add(match[1]!);
    expect(codes.size).toBeGreaterThan(30);
    for (const code of codes) expect(Object.keys(DASHBOARD_DECISION_CODES), code).toContain(code);
  });
});
