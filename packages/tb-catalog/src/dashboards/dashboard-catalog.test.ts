import { describe, expect, it } from "vitest";
import {
  DASHBOARD_REFRESH_INTERVALS,
  DASHBOARD_WIDGET_CATALOG,
  DASHBOARD_WIDGET_GROUPS,
  DASHBOARD_WIDGET_TYPES,
  convertDashboardConfig,
  dashboardValueKind,
  dashboardWidgetProps,
  isDashboardRefreshInterval,
  isDashboardWidgetType,
  knownDashboardConfig,
  resolveDashboardRoles,
  validateDashboardWidgetConfig,
  isPresentationWidget,
  type DashboardWidgetDefinition,
} from "./dashboard-catalog.js";
import { WIDGET_CATALOG, type WidgetName } from "../widgets/widget-catalog.js";

const entry = (type: keyof typeof DASHBOARD_WIDGET_CATALOG) => DASHBOARD_WIDGET_CATALOG[type] as DashboardWidgetDefinition;

describe("the dashboard widget catalog", () => {
  it("lists every type once, by group - the page catalog's display widgets among them (D3)", () => {
    expect(DASHBOARD_WIDGET_TYPES).toEqual([
      "KPI", "GAUGE", "PROGRESS", "BAR", "BAR_HORIZONTAL", "COMBO", "WATERFALL", "LEADERBOARD", "LINE", "AREA", "PIE", "DONUT", "FUNNEL", "TREEMAP", "SUNBURST",
      "HEATMAP", "CALENDAR", "SCATTER", "MAP", "TABLE", "DETAIL", "PIVOT",
      "TImage", "THeading", "TText", "TQrCode", "UBadge", "UAlert", "USeparator", "TFrame",
    ]);
    // One Progress (D12): a data widget - UProgress stays a page's.
    expect(DASHBOARD_WIDGET_TYPES.filter(isPresentationWidget)).toEqual(["TImage", "THeading", "TText", "TQrCode", "UBadge", "UAlert", "USeparator", "TFrame"]);
    for (const type of DASHBOARD_WIDGET_TYPES.filter(isPresentationWidget)) {
      expect(entry(type).page, type).toBe(type);
      expect(entry(type).label, type).toBe(WIDGET_CATALOG[type as WidgetName].label);
    }
    expect(entry("TFrame").group).toBe("insertion");
    expect(entry("TText").group).toBe("visualization");
    expect(isDashboardWidgetType("PIE")).toBe(true);
    expect(isDashboardWidgetType("SCATTER")).toBe(true);
    expect(isDashboardWidgetType("UProgress")).toBe(false);
    expect(isDashboardWidgetType("RADAR")).toBe(false);
  });

  it("describes every entry as the page catalog does: group, description, sizes, roles, props with their defaults", () => {
    for (const type of DASHBOARD_WIDGET_TYPES) {
      const definition = entry(type);
      expect(Object.keys(DASHBOARD_WIDGET_GROUPS), type).toContain(definition.group);
      expect(definition.description, type).toBeTruthy();
      expect(definition.size.w >= definition.minSize.w && definition.size.h >= definition.minSize.h && definition.size.w <= 12, type).toBe(true);
      for (const [key, prop] of Object.entries(definition.props)) {
        expect(prop.description, `${type}.${key}`).toBeTruthy();
        // A boolean always says what unset means - its default, or its description does.
        if (prop.editor === "boolean" && prop.default === undefined) expect(prop.description, `${type}.${key}`).toMatch(/Unset:/);
      }
      if (definition.query) expect(definition.example, type).toMatch(/^SELECT /);
      else expect(definition.roles).toEqual({});
    }
    // Unset, compact follows the format (D4).
    expect(entry("KPI").props.compact!.default).toBeUndefined();
  });
});

describe("dashboardValueKind()", () => {
  it("reads a column's kind from its type - a file from its origin", () => {
    expect(["integer", "bigint", "numeric(12,2)", "double precision"].map((dataType) => dashboardValueKind({ dataType }))).toEqual(["number", "number", "number", "number"]);
    expect(["date", "timestamp with time zone", "timestamp without time zone"].map((dataType) => dashboardValueKind({ dataType }))).toEqual(["time", "time", "time"]);
    expect(dashboardValueKind({ dataType: "point" })).toBe("point");
    expect(dashboardValueKind({ dataType: "uuid", fileReference: true })).toBe("file");
    expect(["text", "boolean", "uuid", "character varying"].map((dataType) => dashboardValueKind({ dataType }))).toEqual(["category", "category", "category", "category"]);
  });
});

describe("validateDashboardWidgetConfig()", () => {
  it("takes every card's description, empty text and phone width (D23), and refuses another phone value", () => {
    expect(validateDashboardWidgetConfig("KPI", { description: "Billed this month", emptyText: "Nothing yet", mobile: "FULL" })).toEqual([]);
    expect(validateDashboardWidgetConfig("TText", { description: "x", mobile: "HIDDEN" })).toEqual([]);
    expect(validateDashboardWidgetConfig("KPI", { mobile: "TINY" })).toEqual([expect.stringContaining("On a phone (mobile) takes one of FULL, HALF, HIDDEN")]);
    expect(validateDashboardWidgetConfig("KPI", { description: "x".repeat(201) })).toEqual([expect.stringContaining("at most 200")]);
    expect(knownDashboardConfig("BAR", { mobile: "HALF", description: "d", nope: 1 })).toEqual({ mobile: "HALF", description: "d" });
  });
  it("accepts the type's own props and roles, and null as unset", () => {
    expect(validateDashboardWidgetConfig("BAR", { roles: { category: "month", values: ["total"] }, stacked: true, color: "emerald", showLegend: null })).toEqual([]);
    expect(validateDashboardWidgetConfig("TABLE", { columnSettings: { total: { align: "right", displayFormat: "#,##0.00", total: "sum" } } })).toEqual([]);
    expect(validateDashboardWidgetConfig("TText", {})).toEqual([]);
  });

  it("refuses a prop or a role the type doesn't have, and a value of the wrong kind - saying what it takes", () => {
    expect(validateDashboardWidgetConfig("MAP", { prefix: "$" })).toEqual(['Map has no prop "prefix" - its props: cluster, displayFormat, color, colorColumn, click, style, bindings, description, emptyText, mobile.']);
    // One format (D4): prefix, suffix and decimals are gone - displayFormat says it all.
    expect(validateDashboardWidgetConfig("KPI", { decimals: 2, suffix: " %" })).toEqual([expect.stringContaining('KPI has no prop "decimals" - its props: displayFormat'), expect.stringContaining('KPI has no prop "suffix"')]);
    expect(validateDashboardWidgetConfig("KPI", { compact: "yes" })).toEqual(['KPI\'s Compact number (compact) takes true or false - got "yes".']);
    expect(validateDashboardWidgetConfig("LINE", { roles: { values: "total", slices: "x" } })).toEqual([
      'Line chart\'s Values (roles.values) takes a list of column names - got "total".',
      'Line chart has no role "slices" - its roles: category, values, series.',
    ]);
    expect(validateDashboardWidgetConfig("PIE", [])).toEqual(["config must be an object."]);
    // A table column's settings by their keys (DB9): `title` isn't one - `label` is.
    expect(validateDashboardWidgetConfig("TABLE", { columnSettings: { total: { title: "Importe", hidden: "no" } } })).toEqual([
      expect.stringMatching(/^Table's columnSettings\.total has no "title" - it takes: label, shortLabel/),
      'Table\'s columnSettings.total.hidden takes true or false - got "no".',
    ]);
    // Each value's type too (DB19), and a total's kind (D28).
    expect(validateDashboardWidgetConfig("TABLE", { columnSettings: { importe: { bold: "si", total: "suma", align: "middle" } } })).toEqual([
      'Table\'s columnSettings.importe.align is one of left, center, right - got "middle".',
      'Table\'s columnSettings.importe.bold takes true or false - got "si".',
      'Table\'s columnSettings.importe.total is one of sum, avg, min, max, count - got "suma".',
    ]);
    expect(validateDashboardWidgetConfig("TABLE", { showTotals: true })).toEqual([expect.stringContaining('Table has no prop "showTotals"')]);
    // Styles: the page catalog's common block, each one of its values.
    expect(validateDashboardWidgetConfig("KPI", { style: { padding: "m", border: "primary", background: "elevated" } })).toEqual([]);
    expect(validateDashboardWidgetConfig("KPI", { style: { border: "thick", glow: "x" } })).toEqual([
      'KPI\'s style.border is one of muted, accented, primary - got "thick".',
      expect.stringContaining('KPI\'s style has no "glow"'),
    ]);
  });
});

describe("knownDashboardConfig() and convertDashboardConfig()", () => {
  it("keeps only the type's own props and roles", () => {
    expect(knownDashboardConfig("MAP", { roles: { label: "name", values: ["x"] }, prefix: "$", cluster: true })).toEqual({ roles: { label: "name" }, cluster: true });
  });

  it("carries the equivalent roles over to another type - Category to Label, Values to Value", () => {
    expect(convertDashboardConfig("BAR", "PIE", { roles: { category: "region", values: ["sales", "returns"] }, stacked: true, showLegend: false })).toEqual({ roles: { category: "region", value: "sales" }, showLegend: false });
    expect(convertDashboardConfig("DONUT", "LINE", { roles: { category: "month", value: "total" } })).toEqual({ roles: { category: "month", values: ["total"] } });
    expect(convertDashboardConfig("MAP", "PIE", { roles: { label: "store", size: "revenue" } })).toEqual({ roles: { category: "store" } });
  });
});

describe("dashboardWidgetProps()", () => {
  it("fills each unset prop with its default, keeping what the author chose", () => {
    expect(dashboardWidgetProps("GAUGE", {})).toEqual({ target: 100 });
    expect(dashboardWidgetProps("GAUGE", { compact: false, target: null })).toEqual({ target: 100, compact: false });
    expect(dashboardWidgetProps("KPI", {})).toMatchObject({ showDelta: false, sparkline: false });
  });
});

describe("resolveDashboardRoles()", () => {
  const sales = [{ name: "month", dataType: "date" }, { name: "seller", dataType: "text" }, { name: "total", dataType: "numeric" }, { name: "units", dataType: "bigint" }, { name: "_color", dataType: "text" }];

  it("fills each role by kind and position - never by name, never a _ column", () => {
    expect(resolveDashboardRoles("BAR", {}, sales)).toEqual({
      roles: { category: { columns: ["month"], source: "default", rule: "first-of-kind" }, values: { columns: ["total", "units"], source: "default", rule: "all-of-kind" } },
      errors: [],
    });
    expect(resolveDashboardRoles("PIE", {}, sales).roles).toEqual({ category: { columns: ["month"], source: "default", rule: "first-of-kind" }, value: { columns: ["total"], source: "default", rule: "first-of-kind" } });
  });

  it("takes the roles the config chooses - long format with Series - and fills the rest around them", () => {
    expect(resolveDashboardRoles("LINE", { roles: { series: "seller", values: ["total"] } }, sales).roles).toEqual({
      category: { columns: ["month"], source: "default", rule: "first-of-kind" },
      values: { columns: ["total"], source: "config" },
      series: { columns: ["seller"], source: "config" },
    });
  });

  it("names the role, what it takes and what the query returned", () => {
    expect(resolveDashboardRoles("KPI", { roles: { value: "no_existe" } }, sales).errors).toEqual([
      'KPI\'s Value: the query returns no column "no_existe" - it returns month (date), seller (text), total (numeric), units (bigint), _color (text).',
    ]);
    expect(resolveDashboardRoles("BAR", { roles: { values: ["seller"] } }, sales).errors).toEqual(['Bar chart\'s Values: "seller" is a category - Values takes a number.']);
    expect(resolveDashboardRoles("BAR", {}, [{ name: "mes", dataType: "text" }, { name: "total", dataType: "text" }]).errors).toEqual([
      "Bar chart needs at least one column of a number for Values - the query returns mes (text), total (text).",
    ]);
  });

  it("maps a point by default; latitude and longitude only when chosen - never by a column's name (DB4)", () => {
    const named = [{ name: "store", dataType: "text" }, { name: "lat", dataType: "double precision" }, { name: "lng", dataType: "double precision" }];
    expect(resolveDashboardRoles("MAP", {}, named).errors).toEqual([
      "Map needs a point column for Location, or a Latitude and a Longitude chosen by hand - the query returns store (text), lat (double precision), lng (double precision).",
    ]);
    expect(resolveDashboardRoles("MAP", { roles: { latitude: "lat", longitude: "lng" } }, named)).toMatchObject({ errors: [], roles: { latitude: { columns: ["lat"] }, longitude: { columns: ["lng"] }, label: { columns: ["store"] } } });
    expect(resolveDashboardRoles("MAP", {}, [{ name: "where", dataType: "point" }, ...named]).roles.location).toEqual({ columns: ["where"], source: "default", rule: "first-of-kind" });
  });
});

describe("structured props, checked at every level (DB20)", () => {
  it("takes series, axes, references, thresholds and a click - and refuses a nested key with its path", () => {
    expect(validateDashboardWidgetConfig("BAR", {
      series: { facturado: { label: "Billed", color: "blue", displayFormat: "$ #,##0" }, cobrado_pct: { type: "line", axis: "right", displayFormat: "0.0 %" } },
      axes: { category: { title: "Month" }, value: { min: 0, log: false }, value2: { max: 100, displayFormat: "0 %" } },
      references: [{ type: "line", value: "average", label: "Average" }, { type: "band", from: 60, to: { variable: "meta" }, color: "amber" }],
      click: { action: "FILTER", variable: "sucursal", value: "{{row.sucursal}}" },
      zoom: true,
    })).toEqual([]);
    expect(validateDashboardWidgetConfig("BAR", { series: { facturado: { colour: "blue", type: "pie" } } })).toEqual([
      'Bar chart\'s series.facturado has no "colour" - it takes: label, color, type, axis, displayFormat.',
      'Bar chart\'s series.facturado.type is one of bar, line, area - got "pie".',
    ]);
    expect(validateDashboardWidgetConfig("LINE", { axes: { x: {}, value: { min: "0" } } })).toEqual([
      'Line chart\'s axes has no "x" - it takes: category, value, value2.',
      'Line chart\'s axes.value.min takes a number - got "0".',
    ]);
    expect(validateDashboardWidgetConfig("AREA", { references: [{ type: "line", value: "mean" }, { type: "band", from: 1 }, { type: "arrow" }] })).toEqual([
      'Area chart\'s references[0].value takes a number, average, min, max, median, {column} or {variable} - got "mean".',
      'Area chart\'s references[1] needs "to".',
      'Area chart\'s references[2].type is one of line, band - got "arrow".',
    ]);
  });

  it("thresholds: a base color, then each from a number, {column} or {variable}", () => {
    expect(validateDashboardWidgetConfig("KPI", { thresholds: [{ color: "red" }, { from: 60, color: "amber" }, { from: { variable: "meta" }, color: "green" }] })).toEqual([]);
    expect(validateDashboardWidgetConfig("GAUGE", { thresholds: [{ from: { col: "x" }, color: "purple" }, { from: 10 }] })).toEqual([
      'Gauge\'s thresholds[0].from takes a number, {column} or {variable} - got {"col":"x"}.',
      'Gauge\'s thresholds[1] needs "color".',
    ]);
  });

  it("a click is one of five actions, each with what it needs", () => {
    expect(validateDashboardWidgetConfig("TABLE", { click: { action: "RECORD", dataview: "6f1e2d1c-0000-4000-8000-000000000000", pk: "{{row.id}}" } })).toEqual([]);
    expect(validateDashboardWidgetConfig("PIE", { click: { action: "OPEN" } })).toEqual(['Pie chart\'s click.action is one of FILTER, DATAVIEW, DASHBOARD, RECORD, URL - got "OPEN".']);
    expect(validateDashboardWidgetConfig("KPI", { click: { action: "URL", url: "https://x.example/", target: "_blank" } })).toEqual(['KPI\'s click has no "target" - it takes: action, url, newTab, inEmbeds, hint.']);
  });
});

describe("isDashboardRefreshInterval()", () => {
  it("accepts only the listed intervals, 30 seconds at the least", () => {
    expect(DASHBOARD_REFRESH_INTERVALS.map((interval) => interval.seconds)).toEqual([30, 60, 300, 900, 3600]);
    for (const { seconds } of DASHBOARD_REFRESH_INTERVALS) expect(isDashboardRefreshInterval(seconds)).toBe(true);
    for (const value of [0, 1, 10, 29, 45, 120, "60", null, undefined]) expect(isDashboardRefreshInterval(value)).toBe(false);
  });
});

describe("presentation widgets (D3)", () => {
  it("take their page widget's own props and formulas, as a page control does", () => {
    expect(validateDashboardWidgetConfig("TText", { props: { label: "Hello" }, bindings: { label: { kind: "formula", formula: '"Sales of " + {{vars.seller.label}}' } } })).toEqual([]);
    expect(validateDashboardWidgetConfig("UBadge", { props: { color: "success" }, bindings: { label: { kind: "formula", formula: "{{row.status}}" } } })).toEqual([]);
    expect(validateDashboardWidgetConfig("TImage", { props: { src: "https://example.com/logo.png", aspect: "1:1" }, style: { padding: "s" }, mobile: "HALF" })).toEqual([]);
    // A page's common props (Visible, Name...) aren't a dashboard's; a value of the wrong kind says so.
    expect(validateDashboardWidgetConfig("TText", { props: { visible: false } })).toEqual([expect.stringContaining('Text has no prop "visible" - its props: label')]);
    expect(validateDashboardWidgetConfig("UBadge", { props: { color: "pink" } })).toEqual([expect.stringContaining("has an invalid value")]);
    // Only a formula prop binds - and only to a formula.
    expect(validateDashboardWidgetConfig("THeading", { bindings: { level: { kind: "formula", formula: '"h1"' } } })).toEqual([expect.stringContaining('bindings has no "level" - it binds: title, label')]);
    expect(validateDashboardWidgetConfig("TText", { bindings: { label: { kind: "variable", variable: "x" } } })).toEqual([expect.stringContaining('bindings.label takes {"kind": "formula"')]);
    // Their props live in props, never at the top; and they have no "no data" text - they always draw.
    expect(validateDashboardWidgetConfig("TText", { label: "x", emptyText: "none" })).toEqual([
      expect.stringContaining('Text has no "label"'),
      expect.stringContaining('Text has no "emptyText"'),
    ]);
  });

  it("checks a Frame's URL as a page's, with the dashboard's tokens", () => {
    expect(validateDashboardWidgetConfig("TFrame", { props: { url: "https://track.example/s/{{row.tracking_code}}?u={{user.email}}&p={{vars.period}}" } })).toEqual([]);
    expect(validateDashboardWidgetConfig("TFrame", { props: { url: "https://{{vars.host}}/" } })).toEqual([expect.stringContaining("site must be written out")]);
    expect(validateDashboardWidgetConfig("TFrame", { props: { url: "https://example.com/{{controls.x.value}}" } })).toEqual([expect.stringContaining("tokens only")]);
    expect(validateDashboardWidgetConfig("TFrame", { props: { url: "http://example.com/" } })).toEqual([expect.stringContaining("https")]);
  });

  it("binds any widget's title to a formula - a data widget its title only, kept across a type switch", () => {
    const title = { kind: "formula", formula: '"Sales of " + {{vars.seller.label}}' };
    expect(validateDashboardWidgetConfig("BAR", { bindings: { title } })).toEqual([]);
    expect(validateDashboardWidgetConfig("BAR", { bindings: { color: title } })).toEqual([expect.stringContaining('bindings has no "color" - it binds: title')]);
    expect(convertDashboardConfig("BAR", "LINE", { bindings: { title }, stacked: true })).toEqual({ bindings: { title } });
    expect(knownDashboardConfig("TText", { props: { label: "x" }, bindings: { title }, roles: { a: "b" }, emptyText: "x" })).toEqual({ props: { label: "x" }, bindings: { title } });
  });
});
