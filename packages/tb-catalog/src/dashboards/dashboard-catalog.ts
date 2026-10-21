import { describeShape, isRecord, shapeErrors, type Shape } from "@totalbase/shared";
/**
 * The dashboard widget catalog (Dashboards.md §5, D1): every
 * widget a dashboard can hold, described the way the page widget catalog
 * describes a page's - its label, icon, group and description, its starting
 * and smallest size on the 12-column canvas, its **data contract** (roles),
 * its props (type, default, description) and the capabilities it uses. One
 * catalog, read by the server (which types exist, what a `config` may hold,
 * each role checked against what the query returns), the MCP (`save_widget`'s
 * enum and checks, `totalbase://guide/dashboards`) and the admin (the widget
 * bar, the inspector, a builder per widget turning roles into a chart).
 *
 * A widget's data is an admin-authored SQL query; `config.roles` assigns the
 * query's result columns to the roles of its contract - by name - and the rest
 * of `config` holds its props. A role left unassigned takes its default by
 * type and position (the first number column, every number column...), never
 * by a column's name. Adding a widget is its entry here and its builder
 * (apps/admin/app/utils/dashboard-builders.ts).
 *
 * A **presentation** widget (D3, §5.11) is one of the page catalog's display
 * widgets (`page`: TImage, THeading, TText, UBadge, UAlert, USeparator,
 * TQrCode, TFrame) - the same props, validation and component.
 * Its `config` is a page control's (`props`, `bindings`), its formulas read
 * the dashboard: `{{vars.<name>}}`, `{{user.<field>}}` and, with a query (it
 * may have one), `{{row.<column>}}` (its first row) and `{{rows}}`.
 */

import { PALETTE_COLORS, TABLE_COLUMN_PRESENTATION_KEYS } from "../columns/column-presentation.js";
import { checkFrameUrlTemplate } from "../widgets/frame-url.js";
import { COMMON_STYLE_PROPS, WIDGET_CATALOG, type WidgetDefinition, type WidgetName } from "../widgets/widget-catalog.js";
import { validateWidgetControlConfig } from "../widgets/widget-control.js";
import { AGGREGATES_SHAPE, AXES_SHAPE, AXES_XY_SHAPE, CLICK_SHAPE, PIVOT_SORT_SHAPE, REFERENCES_SHAPE, SERIES_SHAPE, TABLE_COLUMN_SETTINGS_SHAPE, THRESHOLDS_SHAPE } from "./dashboard-shapes.js";

/** What a TABLE widget's column settings may hold (`config.columnSettings.<column>`) - a table column's presentation, hidden, and its total (D28). */
export const DASHBOARD_TABLE_COLUMN_KEYS: readonly string[] = [...TABLE_COLUMN_PRESENTATION_KEYS, "hidden", "total"];

/**
 * What kinds of result column a role takes (Dashboards.md §5.1):
 * `number` - smallint, integer, bigint, numeric, real, double precision;
 * `time` - date, timestamp, timestamptz; `point` - a point; `file` - a uuid
 * whose origin is a foreign key to files; `category` - any other
 * (text, varchar, boolean, uuid, an enum).
 */
export type DashboardValueKind = "number" | "time" | "category" | "point" | "file";

/** The kind of a result column, from its PostgreSQL type (and, for a file, its origin). */
export function dashboardValueKind(column: { dataType: string; fileReference?: boolean }): DashboardValueKind {
  if (column.fileReference) return "file";
  const type = column.dataType.toLowerCase();
  if (/^(smallint|integer|bigint|numeric|real|double precision|decimal)\b/.test(type)) return "number";
  if (/^(date|timestamp)\b/.test(type)) return "time";
  if (type === "point") return "point";
  return "category";
}

/**
 * How a role is filled while the config doesn't assign it: `first` - the first
 * column of a kind it accepts by default, `all` - every such column (a
 * multi-column role), `none` - left empty.
 */
export type DashboardRoleDefault = "first" | "all" | "none";

/** One role of a widget's data contract - what a result column does in it. */
export interface DashboardRole {
  label: string;
  description: string;
  /** The kinds it takes - and picks by default. */
  accepts: readonly DashboardValueKind[];
  /** Kinds it takes only when chosen by hand, never by default (a category role may be a number or a date). */
  manual?: readonly DashboardValueKind[];
  /** One or more columns (the series of a chart) - stored as a list. */
  multiple?: boolean;
  required: boolean;
  default: DashboardRoleDefault;
}

/**
 * How the inspector edits a prop. `column`: one of the query's result columns, by name; `format`: a displayFormat
 * pattern; the structured ones (`tableColumns`, `series`, `axes`, `thresholds`, `references`, `click`) have a `shape`.
 */
export type DashboardPropEditor = "text" | "number" | "boolean" | "color" | "select" | "column" | "format" | "tableColumns" | "series" | "axes" | "thresholds" | "references" | "click" | "aggregates" | "pivotSort";

/** The inspector's sections (Dashboards.md §10.4) - where a prop shows. */
export type DashboardPropSection = "format" | "appearance" | "series" | "axes" | "thresholds" | "events" | "zoomExport";

/** One prop of a widget - what it is, its default (what an unset prop means) and what it does. */
export interface DashboardWidgetProp {
  label: string;
  editor: DashboardPropEditor;
  description: string;
  /** What an unset prop means - `undefined` when unset is its own state (no prefix, the theme's color). */
  default?: string | number | boolean;
  /** `select` editor only. */
  options?: readonly string[];
  /** Where the inspector shows it. */
  section?: DashboardPropSection;
  /** A structured prop's shape - checked at every level (DB20). */
  shape?: Shape;
}

/**
 * What every widget's card takes beside its own props (Dashboards.md §5.1, D23): a description (the ⓘ by
 * its title), what it says with no rows, and how it sits on a phone - the whole width, half of it, or not at all.
 */
export const DASHBOARD_WIDGET_CARD_PROPS = {
  description: { label: "Description", editor: "text", description: "Shown by an ⓘ next to the title - what the widget measures, where its numbers come from." },
  emptyText: { label: "Text with no data", editor: "text", description: "What it says when the query returns no rows. Default: \"No data for this period\" when it reads a date range, else \"No data\"." },
  mobile: { label: "On a phone", editor: "select", options: ["FULL", "HALF", "HIDDEN"], description: "FULL: the whole width; HALF: half, two to a row; HIDDEN: not shown on a phone. Unset: half for a widget a quarter of the desktop wide or less (a KPI), else the whole width." },
} as const satisfies Readonly<Record<string, DashboardWidgetProp>>;

/** Capabilities a widget may declare - common pieces that come later (series, thresholds, conditions, events...). */
export type DashboardCapability = "series" | "thresholds" | "conditions" | "events" | "zoom" | "export";

/** How a widget is drawn - an ECharts option, one of the App's own renderers, or its page widget's component (`presentation`). */
export type DashboardRenderer = "echarts" | "kpi" | "progress" | "ranking" | "table" | "detail" | "pivot" | "map" | "presentation";

/** The groups of the editor's widget bar, in order. */
export const DASHBOARD_WIDGET_GROUPS = {
  indicators: "Indicators",
  comparison: "Comparison",
  trend: "Trend",
  proportion: "Proportion",
  distribution: "Distribution and relation",
  maps: "Maps",
  tables: "Tables",
  visualization: "Visualization",
  insertion: "Insertion",
} as const;
export type DashboardWidgetGroup = keyof typeof DASHBOARD_WIDGET_GROUPS;

export interface DashboardWidgetDefinition {
  label: string;
  icon: string;
  group: DashboardWidgetGroup;
  description: string;
  renderer: DashboardRenderer;
  /** Its starting size on the 12-column canvas, and the smallest it reads well at. */
  size: { w: number; h: number };
  minSize: { w: number; h: number };
  /** Takes a query - a data widget needs one to draw; a presentation widget may have one, for its formulas' rows. */
  query: boolean;
  /** A presentation widget: the page catalog's widget it is - its props, their validation and its component. */
  page?: WidgetName;
  /** Its data contract - each role a result column may take, by id (`config.roles.<id>`). */
  roles: Readonly<Record<string, DashboardRole>>;
  props: Readonly<Record<string, DashboardWidgetProp>>;
  capabilities: readonly DashboardCapability[];
  /** A query that runs anywhere (VALUES, generate_series) - the drawer's "Use this query" and the guide's example. */
  example?: string;
}

// --- Shared roles and props ---------------------------------------------------

const CATEGORY: DashboardRole = {
  label: "Category",
  description: "The axis labels - a date makes a time axis. Defaults to the first column that isn't a number.",
  accepts: ["category", "time"],
  manual: ["number"],
  required: true,
  default: "first",
};
const VALUES: DashboardRole = {
  label: "Values",
  description: "One series per column, in this order. Defaults to every number column.",
  accepts: ["number"],
  multiple: true,
  required: true,
  default: "all",
};
const SERIES: DashboardRole = {
  label: "Series",
  description: "Long format: one series per value of this column (`month, seller, total`) - with one value column. Optional.",
  accepts: ["category"],
  manual: ["number", "time"],
  required: false,
  default: "none",
};
const LABEL: DashboardRole = {
  label: "Label",
  description: "Each row's name. Defaults to the first column that isn't a number.",
  accepts: ["category", "time"],
  manual: ["number"],
  required: true,
  default: "first",
};
const VALUE: DashboardRole = {
  label: "Value",
  description: "Defaults to the first number column.",
  accepts: ["number"],
  required: true,
  default: "first",
};

const COLOR: DashboardWidgetProp = { label: "Color", editor: "color", section: "appearance", description: "A palette hue for its marks - unset, the theme's primary." };
const LEGEND: DashboardWidgetProp = { label: "Show legend", editor: "boolean", default: true, section: "appearance", description: "The series' (or slices') names, beside the chart." };
const FORMAT: DashboardWidgetProp = {
  label: "Format",
  editor: "format",
  section: "format",
  description:
    "How its numbers read - a displayFormat pattern: \"$ #,##0\", \"#,##0.00\", \"0.0 %\" (% never multiplies: 85 reads 85.0 %), \"0.0 h\", \"CURRENCY:ARS\". Unset: the value column's own (its presentation), else the locale's.",
};
const COMPACT: DashboardWidgetProp = {
  label: "Compact number",
  editor: "boolean",
  section: "format",
  description: "Abbreviates large numbers - 11.6M, 2.4K - keeping the format's text and decimals (\"$ #,##0\" + compact: $ 1.3M). Unset: on, unless a format applies (its own or its column's).",
};
const SERIES_PROP: DashboardWidgetProp = {
  label: "Series",
  editor: "series",
  section: "series",
  shape: SERIES_SHAPE,
  description:
    "Per value column - or, in long format, per value of the Series column: {label, color (a palette hue), type: bar|line|area, axis: left|right, displayFormat}. Unset: the column's title and format; in long format, the Series column's value labels and colors (its presentation).",
};
const AXES_PROP: DashboardWidgetProp = {
  label: "Axes",
  editor: "axes",
  section: "axes",
  shape: AXES_SHAPE,
  description: "{category: {title}, value: {title, min, max, log, displayFormat}, value2: {...}} - value2 is the right axis, used by series with axis: right. Unset min: 0 for bars and areas, fitted to the data for lines.",
};
const REFERENCES_PROP: DashboardWidgetProp = {
  label: "Reference lines",
  editor: "references",
  section: "thresholds",
  shape: REFERENCES_SHAPE,
  description:
    'Lines and bands on the value axis: {type: "line", value: a number | average | min | max | median | {column} | {variable}, label, color, series?} or {type: "band", from, to, label, color}. Labels read in the axis\' format.',
};
const THRESHOLDS_PROP: DashboardWidgetProp = {
  label: "Thresholds",
  editor: "thresholds",
  section: "thresholds",
  shape: THRESHOLDS_SHAPE,
  description: 'Colors by value, in order: [{color: "red"}, {from: 60, color: "amber"}, {from: 80, color: "green"}] - the first, without from, the base. from: a number, {column} (the widget\'s row) or {variable} (a NUMBER or SELECT variable). Wins over Color.',
};
const CLICK_PROP: DashboardWidgetProp = {
  label: "On click",
  editor: "click",
  section: "events",
  shape: CLICK_SHAPE,
  description:
    'What a click on a mark does: {action: "FILTER", variable, value} sets a variable of this dashboard; {action: "DATAVIEW", dataview, filter} opens a DataView filtered (the where grammar); {action: "DASHBOARD", dashboard, variables, tab}; {action: "RECORD", dataview, pk}; {action: "URL", url, newTab, inEmbeds}. Values are formulas over {{row.<column>}} (_ columns too) and {{vars.<name>}}; targets by id. hint: the tooltip\'s last line.',
};
const ZOOM: DashboardWidgetProp = { label: "Zoom", editor: "boolean", default: false, section: "zoomExport", description: "A bar under the chart, and the wheel or a pinch, to zoom into a range." };
const ROW_COLOR: DashboardWidgetProp = {
  label: "Color column",
  editor: "column",
  section: "appearance",
  description: "A column whose value - a palette name: red, emerald, amber... - colors its row's mark. Unset, a column named _color, if the query returns one.",
};
const STACKED: DashboardWidgetProp = { label: "Stacked", editor: "boolean", default: false, section: "appearance", description: "Stacks the series instead of placing them side by side." };
const SMOOTH: DashboardWidgetProp = { label: "Smooth line", editor: "boolean", default: false, section: "appearance", description: "Curves the line between points." };

const CATEGORY_SERIES_ROLES = { category: CATEGORY, values: VALUES, series: SERIES } as const;

/** More columns for a mark's tooltip (tanda 3) - any kind, shown with their titles and formats. */
const TOOLTIP: DashboardRole = {
  label: "Tooltip",
  description: "More columns shown in a mark's tooltip, with their titles and formats. Optional.",
  accepts: ["category", "number", "time"],
  multiple: true,
  required: false,
  default: "none",
};
const TARGET_ROLE: DashboardRole = { label: "Target", description: "The goal, from the query. Without it, the Target prop.", accepts: ["number"], required: false, default: "none" };
const SHOW_VALUES: DashboardWidgetProp = { label: "Show values", editor: "boolean", default: false, section: "appearance", description: "Each cell's number written in it." };
const PALETTE_SELECT = (label: string, description: string, fallback?: string): DashboardWidgetProp => ({
  label,
  editor: "color",
  section: "appearance",
  description,
  ...(fallback ? { default: fallback } : {}),
});

/** A presentation widget's entry (D3): the page widget's label and icon, its place and sizes on the dashboard's canvas. */
function presentation(
  page: WidgetName,
  group: DashboardWidgetGroup,
  size: { w: number; h: number },
  minSize: { w: number; h: number },
  description: string,
  example: string,
): DashboardWidgetDefinition {
  const entry: WidgetDefinition = WIDGET_CATALOG[page];
  return { label: entry.label, icon: entry.icon, group, description, renderer: "presentation", size, minSize, query: true, page, roles: {}, props: {}, capabilities: [], example };
}

export const DASHBOARD_WIDGET_CATALOG = {
  KPI: {
    label: "KPI",
    icon: "i-lucide-gauge-circle",
    group: "indicators",
    description: "One number, large - with its change and its trend.",
    renderer: "kpi",
    size: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    query: true,
    roles: {
      value: { ...VALUE, description: "The number shown - from the last row. Defaults to the first number column." },
      compare: { label: "Comparison", description: "The value it compares with, from the same row (e.g. last month's). Without it, the previous row's value.", accepts: ["number"], required: false, default: "none" },
      time: { label: "Time", description: "With it, the rows are a series, oldest first: the last is the value, the rest its trend.", accepts: ["time"], required: false, default: "none" },
      target: { label: "Target", description: "A goal from the query - shown as how far the value is from it.", accepts: ["number"], required: false, default: "none" },
    },
    props: {
      displayFormat: FORMAT,
      compact: COMPACT,
      color: COLOR,
      thresholds: THRESHOLDS_PROP,
      click: CLICK_PROP,
      showDelta: { label: "Show change", editor: "boolean", default: false, section: "appearance", description: "Percent change vs. the comparison, green up / red down." },
      sparkline: { label: "Show trend", editor: "boolean", default: false, section: "appearance", description: "A small line of the value across the rows (order them by time)." },
      lowerIsBetter: { label: "Lower is better", editor: "boolean", default: false, section: "appearance", description: "Flips the change's colors - for costs or response times." },
    },
    capabilities: ["thresholds", "events", "export"],
    example: "SELECT 1250 AS revenue, 1100 AS previous",
  },
  GAUGE: {
    label: "Gauge",
    icon: "i-lucide-gauge",
    group: "indicators",
    description: "A value on an arc, against its target.",
    renderer: "echarts",
    size: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    query: true,
    roles: {
      value: { ...VALUE, description: "The value on the arc - from the last row. Defaults to the first number column." },
      target: { label: "Target", description: "The full arc, from the query. Without it, the Target prop.", accepts: ["number"], required: false, default: "none" },
    },
    props: {
      target: { label: "Target", editor: "number", default: 100, section: "format", description: "The value the full arc stands for, when the query has no Target column." },
      displayFormat: FORMAT,
      compact: COMPACT,
      color: COLOR,
      thresholds: { ...THRESHOLDS_PROP, description: `${THRESHOLDS_PROP.description} On a gauge, the arc in bands of those colors.` },
      click: CLICK_PROP,
    },
    capabilities: ["thresholds", "events", "export"],
    example: "SELECT 72 AS satisfaction",
  },
  PROGRESS: {
    label: "Progress",
    icon: "i-lucide-loader",
    group: "indicators",
    description: "A bar of a value toward its target - \"$ 13.9M of $ 30M · 46 %\", colored by thresholds.",
    renderer: "progress",
    size: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    query: true,
    roles: {
      value: { ...VALUE, description: "The value - from the last row. Defaults to the first number column." },
      target: TARGET_ROLE,
    },
    props: {
      target: { label: "Target", editor: "number", default: 100, section: "format", description: "The goal, when the query has no Target column." },
      displayFormat: FORMAT,
      compact: COMPACT,
      color: COLOR,
      showTarget: { label: "Show target", editor: "boolean", default: true, section: "appearance", description: "\"of $ 30M\" after the value." },
      showPercent: { label: "Show percent", editor: "boolean", default: true, section: "appearance", description: "The share of the target reached - past it, its real value (115 %)." },
      thresholds: { ...THRESHOLDS_PROP, description: `${THRESHOLDS_PROP.description} On the value, or on the percent with thresholdsOn: PERCENT.` },
      thresholdsOn: { label: "Thresholds on", editor: "select", options: ["VALUE", "PERCENT"], default: "VALUE", section: "thresholds", description: "VALUE: the thresholds' from is the value; PERCENT: the percent of the target (60 = 60 %)." },
      click: CLICK_PROP,
    },
    capabilities: ["thresholds", "events", "export"],
    example: "SELECT 13900000 AS billed, 30000000 AS goal",
  },
  BAR: {
    label: "Bar chart",
    icon: "i-lucide-bar-chart-3",
    group: "comparison",
    description: "Vertical bars - one group per category, one bar per series.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: CATEGORY_SERIES_ROLES,
    props: { stacked: STACKED, displayFormat: FORMAT, compact: COMPACT, color: COLOR, colorColumn: ROW_COLOR, showLegend: LEGEND, series: SERIES_PROP, axes: AXES_PROP, references: REFERENCES_PROP, click: CLICK_PROP, zoom: ZOOM },
    capabilities: ["series", "thresholds", "events", "zoom", "export"],
    example: "SELECT * FROM (VALUES ('North', 120, 80), ('South', 95, 110), ('East', 140, 60), ('West', 70, 90)) AS t(region, sales, returns)",
  },
  BAR_HORIZONTAL: {
    label: "Horizontal bar",
    icon: "i-lucide-bar-chart-horizontal",
    group: "comparison",
    description: "Horizontal bars - for long labels; order the query yourself.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: CATEGORY_SERIES_ROLES,
    props: { stacked: STACKED, displayFormat: FORMAT, compact: COMPACT, color: COLOR, colorColumn: ROW_COLOR, showLegend: LEGEND, series: SERIES_PROP, axes: AXES_PROP, references: REFERENCES_PROP, click: CLICK_PROP, zoom: ZOOM },
    capabilities: ["series", "thresholds", "events", "zoom", "export"],
    example: "SELECT * FROM (VALUES ('Laptops', 320), ('Phones', 280), ('Tablets', 150), ('Monitors', 90)) AS t(product, stock) ORDER BY stock DESC",
  },
  COMBO: {
    label: "Combo chart",
    icon: "i-lucide-chart-column-big",
    group: "comparison",
    description: "Bars and lines on two axes - the first value column as bars on the left, the rest as lines on the right.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: { category: CATEGORY, values: { ...VALUES, description: "Two or more columns: the first as bars (left axis), the rest as lines (right axis) - series changes that." }, tooltip: TOOLTIP },
    props: { stacked: STACKED, displayFormat: FORMAT, compact: COMPACT, color: COLOR, colorColumn: ROW_COLOR, showLegend: LEGEND, series: SERIES_PROP, axes: AXES_PROP, references: REFERENCES_PROP, click: CLICK_PROP, zoom: ZOOM },
    capabilities: ["series", "thresholds", "events", "zoom", "export"],
    example: "SELECT * FROM (VALUES ('Jan', 120, 3500.5), ('Feb', 140, 3720), ('Mar', 95, 4010.25)) AS t(month, visits, avg_ticket)",
  },
  WATERFALL: {
    label: "Waterfall",
    icon: "i-lucide-chart-no-axes-column-decreasing",
    group: "comparison",
    description: "How a total is built - each row a change up or down; a total row the running sum so far.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: {
      category: CATEGORY,
      value: { ...VALUE, description: "Each row's change, with its sign. Defaults to the first number column." },
      total: { label: "Total", description: "Chosen by hand: a true/false column - a true row draws the running total so far from 0 (its value is ignored).", accepts: [], manual: ["category"], required: false, default: "none" },
      tooltip: TOOLTIP,
    },
    props: {
      displayFormat: FORMAT,
      compact: COMPACT,
      finalTotal: { label: "Final total", editor: "boolean", default: true, section: "appearance", description: "A last bar with the running total." },
      finalTotalLabel: { label: "Final total's name", editor: "text", section: "appearance", description: "Unset: \"Total\" in the viewer's language." },
      increaseColor: PALETTE_SELECT("Increase color", "A palette hue for a change up.", "green"),
      decreaseColor: PALETTE_SELECT("Decrease color", "A palette hue for a change down.", "red"),
      totalColor: PALETTE_SELECT("Total color", "A palette hue for a total - unset, the theme's primary."),
      axes: AXES_PROP,
      references: REFERENCES_PROP,
      click: CLICK_PROP,
    },
    capabilities: ["thresholds", "events", "export"],
    example: "SELECT * FROM (VALUES (1, 'Sales', 1000, false), (2, 'Discounts', -150, false), (3, 'Net', NULL, true), (4, 'Paid', -600, false)) AS t(n, step, amount, is_total) ORDER BY n",
  },
  LEADERBOARD: {
    label: "Leaderboard",
    icon: "i-lucide-list-ordered",
    group: "comparison",
    description: "A ranked list with bars - order and LIMIT the query yourself.",
    renderer: "ranking",
    size: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: { category: { ...LABEL, label: "Category" }, value: { ...VALUE, description: "The ranked value. Defaults to the first number column." }, image: { label: "Image", description: "A file column (an image) shown as a thumbnail beside each row. Defaults to the first file column.", accepts: ["file"], required: false, default: "first" } },
    props: { displayFormat: FORMAT, compact: COMPACT, color: COLOR, colorColumn: ROW_COLOR, click: CLICK_PROP },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES ('Ana', 48), ('Luis', 41), ('Marta', 35), ('Pedro', 22)) AS t(agent, resolved) ORDER BY resolved DESC LIMIT 10",
  },
  LINE: {
    label: "Line chart",
    icon: "i-lucide-line-chart",
    group: "trend",
    description: "One line per series, over time or categories - oldest first.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: CATEGORY_SERIES_ROLES,
    props: { smooth: SMOOTH, displayFormat: FORMAT, compact: COMPACT, color: COLOR, showLegend: LEGEND, series: SERIES_PROP, axes: AXES_PROP, references: REFERENCES_PROP, click: CLICK_PROP, zoom: ZOOM },
    capabilities: ["series", "thresholds", "events", "zoom", "export"],
    example: "SELECT m::date AS month, (100 + 20 * extract(month FROM m))::int AS revenue FROM generate_series(date '2026-01-01', date '2026-12-01', interval '1 month') AS m",
  },
  AREA: {
    label: "Area chart",
    icon: "i-lucide-area-chart",
    group: "trend",
    description: "Lines filled below - totals over time.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: CATEGORY_SERIES_ROLES,
    props: { stacked: STACKED, smooth: SMOOTH, displayFormat: FORMAT, compact: COMPACT, color: COLOR, showLegend: LEGEND, series: SERIES_PROP, axes: AXES_PROP, references: REFERENCES_PROP, click: CLICK_PROP, zoom: ZOOM },
    capabilities: ["series", "thresholds", "events", "zoom", "export"],
    example: "SELECT m::date AS month, sum(10 + extract(month FROM m)::int) OVER (ORDER BY m) AS cumulative FROM generate_series(date '2026-01-01', date '2026-12-01', interval '1 month') AS m",
  },
  PIE: {
    label: "Pie chart",
    icon: "i-lucide-pie-chart",
    group: "proportion",
    description: "Each row a slice of the whole.",
    renderer: "echarts",
    size: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: { category: { ...LABEL, label: "Category", description: "Each slice's name. Defaults to the first column that isn't a number." }, value: { ...VALUE, description: "The slice sizes. Defaults to the first number column." } },
    props: { displayFormat: FORMAT, compact: COMPACT, colorColumn: ROW_COLOR, showLegend: LEGEND, click: CLICK_PROP },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES ('Online', 540, 'blue'), ('Stores', 320, 'emerald'), ('Phone', 90, 'amber')) AS t(channel, orders, _color)",
  },
  DONUT: {
    label: "Donut chart",
    icon: "i-lucide-circle-dashed",
    group: "proportion",
    description: "A pie with a hole - each row a slice of the whole.",
    renderer: "echarts",
    size: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: { category: { ...LABEL, label: "Category", description: "Each slice's name. Defaults to the first column that isn't a number." }, value: { ...VALUE, description: "The slice sizes. Defaults to the first number column." } },
    props: { displayFormat: FORMAT, compact: COMPACT, colorColumn: ROW_COLOR, showLegend: LEGEND, click: CLICK_PROP },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES ('Open', 12), ('In progress', 7), ('Resolved', 43)) AS t(status, tickets)",
  },
  FUNNEL: {
    label: "Funnel",
    icon: "i-lucide-filter",
    group: "proportion",
    description: "Steps in the query's order, each with its share of the first or the previous step.",
    renderer: "echarts",
    size: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: { category: { ...LABEL, label: "Category", description: "Each step's name - in the query's order. Defaults to the first column that isn't a number." }, value: { ...VALUE, description: "Each step's value - never negative. Defaults to the first number column." }, tooltip: TOOLTIP },
    props: {
      displayFormat: FORMAT,
      compact: COMPACT,
      colorColumn: ROW_COLOR,
      showLegend: { ...LEGEND, default: false },
      sort: { label: "Order", editor: "select", options: ["NONE", "DESC"], default: "NONE", section: "appearance", description: "NONE: the query's order; DESC: the largest first." },
      conversion: { label: "Conversion", editor: "select", options: ["FIRST", "PREVIOUS", "NONE"], default: "FIRST", section: "format", description: "Each step's percent of the first step, of the previous one, or none." },
      click: CLICK_PROP,
    },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES (1, 'Visits', 1200), (2, 'Sign-ups', 480), (3, 'Orders', 210), (4, 'Paid', 160)) AS t(_n, step, people) ORDER BY _n",
  },
  TREEMAP: {
    label: "Treemap",
    icon: "i-lucide-layout-grid",
    group: "proportion",
    description: "Nested rectangles by levels (branch → category → product), each sized by its value; a parent is the sum of its children.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: {
      levels: { label: "Levels", description: "The hierarchy, outermost first - every column that isn't a number by default. A NULL ends its branch there.", accepts: ["category", "time"], manual: ["number"], multiple: true, required: true, default: "all" },
      value: { ...VALUE, description: "A leaf's value - summable (never an average), never negative. Defaults to the first number column." },
      tooltip: TOOLTIP,
    },
    props: {
      displayFormat: FORMAT,
      compact: COMPACT,
      colorColumn: ROW_COLOR,
      showLabels: { label: "Show labels", editor: "boolean", default: true, section: "appearance", description: "Each node's name in it." },
      visibleLevels: { label: "Levels shown", editor: "number", default: 2, section: "appearance", description: "How many levels at once - a tap goes down one, the breadcrumb back." },
      click: CLICK_PROP,
    },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES ('North', 'Drinks', 'Water', 120), ('North', 'Drinks', 'Soda', 90), ('North', 'Food', 'Bread', 60), ('South', 'Drinks', 'Water', 70), ('South', 'Food', 'Cheese', 110)) AS t(branch, category, product, sold)",
  },
  SUNBURST: {
    label: "Sunburst",
    icon: "i-lucide-sun",
    group: "proportion",
    description: "Rings by levels, the innermost the first; a parent is the sum of its children.",
    renderer: "echarts",
    size: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: {
      levels: { label: "Levels", description: "The hierarchy, innermost ring first - every column that isn't a number by default. A NULL ends its branch there.", accepts: ["category", "time"], manual: ["number"], multiple: true, required: true, default: "all" },
      value: { ...VALUE, description: "A leaf's value - summable (never an average), never negative. Defaults to the first number column." },
      tooltip: TOOLTIP,
    },
    props: {
      displayFormat: FORMAT,
      compact: COMPACT,
      colorColumn: ROW_COLOR,
      showLabels: { label: "Show labels", editor: "boolean", default: true, section: "appearance", description: "Each node's name on it." },
      click: CLICK_PROP,
    },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES ('North', 'Drinks', 'Water', 120), ('North', 'Drinks', 'Soda', 90), ('North', 'Food', 'Bread', 60), ('South', 'Drinks', 'Water', 70), ('South', 'Food', 'Cheese', 110)) AS t(branch, category, product, sold)",
  },
  HEATMAP: {
    label: "Heatmap",
    icon: "i-lucide-grid-3x3",
    group: "distribution",
    description: "A grid of two categories (day × hour, branch × month), each cell colored by its value; a missing cell stays empty.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 4, h: 3 },
    query: true,
    roles: {
      x: { label: "X", description: "The columns - in the query's order (a date sorted). Defaults to the first column that isn't a number; a number (an hour) only by hand.", accepts: ["category", "time"], manual: ["number"], required: true, default: "first" },
      y: { label: "Y", description: "The rows - in the query's order (a date sorted). Defaults to the next column that isn't a number; a number (a weekday) only by hand.", accepts: ["category", "time"], manual: ["number"], required: true, default: "first" },
      value: { ...VALUE, description: "Each cell's value. Defaults to the first number column." },
      tooltip: TOOLTIP,
    },
    props: {
      color: { ...COLOR, description: "The scale's hue, from the background to it - unset, the theme's primary. Thresholds draw fixed bands instead." },
      displayFormat: FORMAT,
      compact: COMPACT,
      showValues: SHOW_VALUES,
      showLegend: LEGEND,
      thresholds: { ...THRESHOLDS_PROP, description: `${THRESHOLDS_PROP.description} On a heatmap, bands of those colors with their legend.` },
      click: { ...CLICK_PROP, description: `${CLICK_PROP.description} On a heatmap, a cell.` },
    },
    capabilities: ["thresholds", "events", "export"],
    example: "SELECT (ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])[d] AS weekday, lpad(h::text, 2, '0') AS hour, (random() * 100)::int AS readings FROM generate_series(1, 7) AS d, generate_series(0, 23) AS h ORDER BY d, h",
  },
  CALENDAR: {
    label: "Calendar heatmap",
    icon: "i-lucide-calendar-days",
    group: "distribution",
    description: "Every day of a year colored by its value - a year per row, the latest three.",
    renderer: "echarts",
    size: { w: 12, h: 3 },
    minSize: { w: 6, h: 3 },
    query: true,
    roles: {
      date: { label: "Date", description: "The day. Defaults to the first date column.", accepts: ["time"], required: true, default: "first" },
      value: { ...VALUE, description: "Each day's value. Defaults to the first number column." },
      tooltip: TOOLTIP,
    },
    props: {
      color: { ...COLOR, description: "The scale's hue, from the background to it - unset, the theme's primary. Thresholds draw fixed bands instead." },
      displayFormat: FORMAT,
      compact: COMPACT,
      showLegend: LEGEND,
      thresholds: { ...THRESHOLDS_PROP, description: `${THRESHOLDS_PROP.description} On a calendar, bands of those colors with their legend.` },
      click: { ...CLICK_PROP, description: `${CLICK_PROP.description} On a calendar, a day.` },
    },
    capabilities: ["thresholds", "events", "export"],
    example: "SELECT d::date AS day, (random() * 20)::int AS visits FROM generate_series(date '2026-01-01', date '2026-12-31', interval '1 day') AS d",
  },
  SCATTER: {
    label: "Scatter and bubbles",
    icon: "i-lucide-chart-scatter",
    group: "distribution",
    description: "Points by two numbers - with Size, bubbles; with Group, a series per group.",
    renderer: "echarts",
    size: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: {
      x: { label: "X", description: "Defaults to the first number column; a date chosen by hand.", accepts: ["number"], manual: ["time"], required: true, default: "first" },
      y: { label: "Y", description: "Defaults to the next number column.", accepts: ["number"], required: true, default: "first" },
      size: { label: "Size", description: "Each point's size (radius by its square root, 6 to 40 px) - bubbles. Optional.", accepts: ["number"], required: false, default: "none" },
      label: { label: "Label", description: "Each point's name in its tooltip. Defaults to the first column that isn't a number.", accepts: ["category"], manual: ["time"], required: false, default: "first" },
      group: { label: "Group", description: "A series per value of this column, colored by its presentation. Optional.", accepts: [], manual: ["category"], required: false, default: "none" },
      tooltip: TOOLTIP,
    },
    props: {
      displayFormat: FORMAT,
      compact: COMPACT,
      color: COLOR,
      showLegend: LEGEND,
      series: { ...SERIES_PROP, description: "Per Group value: {label, color}. Unset: the Group column's presentation (its CHECK list's labels and colors)." },
      axes: { label: "Axes", editor: "axes", section: "axes", shape: AXES_XY_SHAPE, description: "{x: {title, min, max, log, displayFormat}, y: {...}} - unset min fits the data." },
      references: { ...REFERENCES_PROP, description: `${REFERENCES_PROP.description} On a scatter, axis: "x" or "y" (default y).` },
      click: { ...CLICK_PROP, description: `${CLICK_PROP.description} On a scatter, a point.` },
      zoom: { ...ZOOM, description: "Bars under and beside the chart, and the wheel or a pinch, to zoom into a range of x and y." },
    },
    capabilities: ["series", "thresholds", "events", "zoom", "export"],
    example: "SELECT * FROM (VALUES ('Ana', 12, 3500, 42000, 'GOLD'), ('Luis', 30, 2100, 63000, 'BLACK'), ('Marta', 7, 5200, 36400, 'GOLD'), ('Pedro', 18, 2900, 52200, 'PLATINUM')) AS t(customer, visits, avg_ticket, spent, level)",
  },
  MAP: {
    label: "Map",
    icon: "i-lucide-map",
    group: "maps",
    description: "Points on a street map - from a point column, or latitude and longitude.",
    renderer: "map",
    size: { w: 6, h: 5 },
    minSize: { w: 3, h: 3 },
    query: true,
    roles: {
      location: { label: "Location", description: "A point column (x = longitude, y = latitude). Defaults to the first point column.", accepts: ["point"], required: false, default: "first" },
      latitude: { label: "Latitude", description: "Only without a point column - chosen by hand, with Longitude.", accepts: [], manual: ["number"], required: false, default: "none" },
      longitude: { label: "Longitude", description: "Only without a point column - chosen by hand, with Latitude.", accepts: [], manual: ["number"], required: false, default: "none" },
      label: { label: "Label", description: "Shown on a point's tooltip. Defaults to the first column that isn't a number.", accepts: ["category"], manual: ["number", "time"], required: false, default: "first" },
      size: { label: "Size", description: "Scales each point by this value. Optional.", accepts: ["number"], required: false, default: "none" },
    },
    props: {
      cluster: { label: "Group nearby points", editor: "boolean", default: false, section: "appearance", description: "Joins points close together into a numbered circle." },
      displayFormat: { ...FORMAT, description: "How the Size value reads in a point's tooltip - a displayFormat pattern. Unset: its column's." },
      color: COLOR,
      colorColumn: ROW_COLOR,
      click: CLICK_PROP,
    },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES ('Buenos Aires', point(-58.38, -34.60), 120), ('Córdoba', point(-64.18, -31.42), 80), ('Rosario', point(-60.65, -32.95), 60)) AS t(store, location, revenue)",
  },
  TABLE: {
    label: "Table",
    icon: "i-lucide-table",
    group: "tables",
    description: "The rows as they come - columns starting with _ never show.",
    renderer: "table",
    size: { w: 12, h: 5 },
    minSize: { w: 4, h: 3 },
    query: true,
    roles: {
      columns: { label: "Columns", description: "The columns shown, in this order. Defaults to every column (but _ ones).", accepts: ["category", "number", "time", "point", "file"], multiple: true, required: true, default: "all" },
    },
    props: {
      columnSettings: {
        label: "Column settings",
        editor: "tableColumns",
        section: "format",
        shape: TABLE_COLUMN_SETTINGS_SHAPE,
        description:
          "Per column, by name: {label, shortLabel, displayFormat, emptyText, booleanLabels, linkType, options, align, fontSize, bold, italic, mono, underline, strike, color, background, hidden, total} - over what its presentation says. total: sum, avg, min, max or count - a footer row computed by PostgreSQL over every row the query returns (not only those shown), in the column's format.",
      },
      colorColumn: { ...ROW_COLOR, description: "A column whose value - a palette name - tints its row. Unset, a column named _color. _<column>_color shows that column as colored badges." },
      click: { ...CLICK_PROP, description: `${CLICK_PROP.description} On a table, a click on a row.` },
    },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES (1001, 'Ana', 250.5, 'PAID', 'emerald'), (1002, 'Luis', 99.9, 'PENDING', 'amber'), (1003, 'Marta', 410, 'CANCELLED', 'red')) AS t(order_no, customer, total, status, _status_color)",
  },
  DETAIL: {
    label: "Detail",
    icon: "i-lucide-id-card",
    group: "tables",
    description: "One row as label / value pairs, with its image - the query's first row.",
    renderer: "detail",
    size: { w: 4, h: 4 },
    minSize: { w: 3, h: 2 },
    query: true,
    roles: {
      columns: { label: "Columns", description: "The fields shown, in this order. Defaults to every column (but _ ones).", accepts: ["category", "number", "time", "point", "file"], multiple: true, required: true, default: "all" },
      image: { label: "Image", description: "A file column shown as its image, above (or beside, with layout TWO). Defaults to the first file column.", accepts: ["file"], required: false, default: "first" },
    },
    props: {
      layout: { label: "Layout", editor: "select", options: ["AUTO", "ONE", "TWO"], default: "AUTO", section: "appearance", description: "AUTO: two columns from 6 wide, one on a phone; ONE; TWO." },
      columnSettings: {
        label: "Field settings",
        editor: "tableColumns",
        section: "format",
        shape: TABLE_COLUMN_SETTINGS_SHAPE,
        description: "Per column, by name: {label, displayFormat, emptyText, booleanLabels, linkType, options, hidden...} - over what its presentation says (a total doesn't apply).",
      },
      click: { ...CLICK_PROP, description: `${CLICK_PROP.description} On a detail, the card.` },
    },
    capabilities: ["events", "export"],
    example: "SELECT 'Ana Pérez' AS name, date '2026-10-01' AS last_visit, 12 AS visits, 'GOLD' AS level",
  },
  PIVOT: {
    label: "Pivot table",
    icon: "i-lucide-table-2",
    group: "tables",
    description: "The query's detail rows aggregated by PostgreSQL into rows × columns, with subtotals and totals - never added up on screen.",
    renderer: "pivot",
    size: { w: 12, h: 5 },
    minSize: { w: 4, h: 3 },
    query: true,
    roles: {
      rows: { label: "Rows", description: "One or more levels down the side, outermost first. Defaults to the first column that isn't a number.", accepts: ["category", "time"], manual: ["number"], multiple: true, required: true, default: "first" },
      columns: { label: "Columns", description: "Levels across the top (at most 60 values). Optional.", accepts: [], manual: ["category", "time", "number"], multiple: true, required: false, default: "none" },
      values: { label: "Values", description: "What is aggregated - each with its aggregate (aggregates). Defaults to every number column.", accepts: ["number"], multiple: true, required: true, default: "all" },
    },
    props: {
      aggregates: {
        label: "Aggregates",
        editor: "aggregates",
        section: "format",
        shape: AGGREGATES_SHAPE,
        description: 'Required for each value: {"total": "sum", "ticket": "avg"} - sum, avg, min, max or count, computed by PostgreSQL over the detail rows (an average is the real one, never an average of averages).',
      },
      subtotals: { label: "Subtotals", editor: "boolean", default: true, section: "appearance", description: "A subtotal for each level of the rows." },
      rowTotals: { label: "Row totals", editor: "boolean", default: true, section: "appearance", description: "A total column at the right." },
      columnTotals: { label: "Column totals", editor: "boolean", default: true, section: "appearance", description: "A total row at the bottom." },
      sortBy: { label: "Sort rows by", editor: "pivotSort", section: "appearance", shape: PIVOT_SORT_SHAPE, description: '{value: "total", direction: "DESC"} - rows ordered by a value\'s total. Unset: by the rows\' own values.' },
      columnSettings: {
        label: "Value settings",
        editor: "tableColumns",
        section: "format",
        shape: TABLE_COLUMN_SETTINGS_SHAPE,
        description: "Per value or row column, by name: {label, displayFormat, emptyText...} - over what its presentation says.",
      },
      click: { ...CLICK_PROP, description: `${CLICK_PROP.description} On a pivot, a detail cell - {{row.<column>}} its rows' and columns' values; a total isn't clickable.` },
    },
    capabilities: ["events", "export"],
    example: "SELECT * FROM (VALUES ('North', 'Jan', 120.5), ('North', 'Feb', 99), ('South', 'Jan', 80), ('South', 'Feb', 140.25), ('North', 'Jan', 30)) AS t(branch, month, total)",
  },
  TImage: presentation("TImage", "visualization", { w: 3, h: 3 }, { w: 1, h: 1 }, "A fixed image - a logo, a branch's floor plan: a file uploaded here (public) or an https URL.", "SELECT 'Main branch' AS branch"),
  THeading: presentation("THeading", "visualization", { w: 12, h: 1 }, { w: 2, h: 1 }, 'A section title - a formula may name what is shown: "Sales of " + {{vars.seller.label}}.', "SELECT 'North' AS region"),
  TText: presentation("TText", "visualization", { w: 6, h: 2 }, { w: 2, h: 1 }, "A paragraph - its text a formula over the variables, the viewer and the query's rows.", "SELECT 1250 AS revenue, 1100 AS previous"),
  TQrCode: presentation("TQrCode", "visualization", { w: 3, h: 3 }, { w: 2, h: 2 }, "A QR code of a value - a link to this report, a device's code - drawn in the browser.", "SELECT 'https://example.com/report' AS link"),
  UBadge: presentation("UBadge", "visualization", { w: 2, h: 1 }, { w: 1, h: 1 }, "A short label - its text and color may be formulas: a state, a count.", "SELECT 'OPEN' AS status"),
  UAlert: presentation("UAlert", "visualization", { w: 6, h: 2 }, { w: 3, h: 1 }, "A message with a title and a description - a warning the query or a variable decides.", "SELECT 3 AS overdue"),
  USeparator: presentation("USeparator", "visualization", { w: 12, h: 1 }, { w: 1, h: 1 }, "A rule between sections, with an optional label.", "SELECT 'This month' AS label"),
  TFrame: presentation("TFrame", "insertion", { w: 6, h: 5 }, { w: 3, h: 3 }, "Another site's page in a sandboxed frame - its URL may take {{vars.…}}, {{user.…}} and {{row.…}} values after the site.", "SELECT 'AB-1234' AS tracking_code"),
} as const satisfies Record<string, DashboardWidgetDefinition>;

export type DashboardWidgetType = keyof typeof DASHBOARD_WIDGET_CATALOG;

/** Every dashboard widget type, in the widget bar's order (by group, then as listed). */
export const DASHBOARD_WIDGET_TYPES = Object.keys(DASHBOARD_WIDGET_CATALOG) as DashboardWidgetType[];

export function isDashboardWidgetType(value: string): value is DashboardWidgetType {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_WIDGET_CATALOG, value);
}

export function dashboardWidgetDefinition(type: DashboardWidgetType): DashboardWidgetDefinition {
  return DASHBOARD_WIDGET_CATALOG[type];
}


function propFits(prop: DashboardWidgetProp, value: unknown): boolean {
  if (prop.shape) return shapeErrors("", prop.shape, value).length === 0;
  switch (prop.editor) {
    case "text":
    case "column":
    case "format":
      return typeof value === "string";
    // A palette hue by name (DB32) - what the inspector offers, light and dark alike.
    case "color":
      return typeof value === "string" && (PALETTE_COLORS as readonly string[]).includes(value);
    case "select":
      return typeof value === "string" && (prop.options ?? []).includes(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return isRecord(value);
  }
}

function expected(prop: DashboardWidgetProp): string {
  if (prop.shape) return describeShape(prop.shape);
  switch (prop.editor) {
    case "select":
      return `one of ${(prop.options ?? []).join(", ")}`;
    case "color":
      return `a palette color: ${PALETTE_COLORS.join(", ")}`;
    case "boolean":
      return "true or false";
    case "number":
      return "a number";
    case "column":
      return "a column name";
    default:
      return "text";
  }
}

/**
 * A dashboard Frame's URL tokens (§5.11): the dashboard's variables, the viewer and the query's first row - each
 * URL-encoded, never before the site. A source, as `FRAME_URL_TOKEN`.
 */
export const DASHBOARD_FRAME_URL_TOKEN = String.raw`\{\{\s*(vars|user|row)\.([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)\s*\}\}`;

/** The binding every widget may have (D3): its card's title as a formula - `config.bindings.title`. */
export const DASHBOARD_TITLE_BINDING = "title";

/** A presentation widget (D3): one of the page catalog's display widgets, drawn by its component. */
export function isPresentationWidget(type: DashboardWidgetType): boolean {
  return (DASHBOARD_WIDGET_CATALOG[type] as DashboardWidgetDefinition).page !== undefined;
}

/** What a widget's card takes besides its own props - a presentation widget has no "no data" text: it always draws. */
export function dashboardCardProps(type: DashboardWidgetType): Readonly<Record<string, DashboardWidgetProp>> {
  if (!isPresentationWidget(type)) return DASHBOARD_WIDGET_CARD_PROPS;
  const { emptyText: _none, ...props } = DASHBOARD_WIDGET_CARD_PROPS;
  return props;
}

/** The page widget's own props a dashboard takes - never the page's common ones (Visible, Name, CSS classes...). */
function pageProps(page: WidgetName): Readonly<Record<string, { label: string; binding?: string }>> {
  return (WIDGET_CATALOG[page] as WidgetDefinition).props;
}

function bindingErrors(label: string, bindings: unknown, bindable: (key: string) => boolean, known: string[]): string[] {
  if (bindings === undefined || bindings === null) return [];
  if (!isRecord(bindings)) return [`${label}'s bindings must map a prop to its formula.`];
  const errors: string[] = [];
  for (const [key, binding] of Object.entries(bindings)) {
    if (!bindable(key)) errors.push(`${label}'s bindings has no "${key}" - it binds: ${known.join(", ")}.`);
    else if (!isRecord(binding) || binding.kind !== "formula" || typeof binding.formula !== "string" || Object.keys(binding).some((k) => k !== "kind" && k !== "formula"))
      errors.push(`${label}'s bindings.${key} takes {"kind": "formula", "formula": "..."} - got ${JSON.stringify(binding)}.`);
  }
  return errors;
}

/**
 * What's wrong with a widget's `config` for its type, before any query: a prop
 * or a role its entry doesn't have, a value of the wrong kind, a role given
 * something that isn't a column name. A null value is unset. Whether each role's
 * columns are in the query and of a kind it takes is `checkDashboardRoles`'s.
 * A presentation widget's `props` and `bindings` are checked as a page control's,
 * its own props only; every widget may bind its title (`bindings.title`).
 */
export function validateDashboardWidgetConfig(type: DashboardWidgetType, config: unknown): string[] {
  return dashboardWidgetConfigIssues(type, config).map((issue) => issue.message);
}

/** One of a widget config's problems, with where it is - `path` relative to config (`roles.value`, `series.paid.color`). */
export interface DashboardConfigIssue {
  path: string;
  message: string;
}

/** {@link validateDashboardWidgetConfig}'s problems with their paths - what apply_dashboard reports (DM2). */
export function dashboardWidgetConfigIssues(type: DashboardWidgetType, config: unknown): DashboardConfigIssue[] {
  if (!isRecord(config)) return [{ path: "", message: "config must be an object." }];
  const definition = DASHBOARD_WIDGET_CATALOG[type] as DashboardWidgetDefinition;
  const card = dashboardCardProps(type) as Readonly<Record<string, DashboardWidgetProp>>;
  const issues: DashboardConfigIssue[] = [];
  const at = (path: string, messages: string[]) => issues.push(...messages.map((message) => ({ path, message })));
  if (definition.page) return presentationIssues(definition, definition.page, config, card);
  for (const [key, value] of Object.entries(config)) {
    if (key === "roles") continue;
    if (key === "style") {
      at("style", styleErrors(definition.label, value));
      continue;
    }
    if (key === "bindings") {
      at("bindings", bindingErrors(definition.label, value, (k) => k === DASHBOARD_TITLE_BINDING, [DASHBOARD_TITLE_BINDING]));
      continue;
    }
    const cardProp = card[key];
    if (cardProp) {
      at(key, cardPropErrors(definition.label, key, cardProp, value));
      continue;
    }
    const prop = definition.props[key];
    if (!prop) at(key, [`${definition.label} has no prop "${key}" - its props: ${[...Object.keys(definition.props), "style", "bindings", ...Object.keys(card)].join(", ")}.`]);
    // A structured prop, at every level (DB20, DB19): each refusal names its path.
    else if (prop.shape) { if (value !== null) issues.push(...shapeErrors(key, prop.shape, value).map((e) => ({ path: e.path, message: `${definition.label}'s ${e.message}` }))); }
    else if (value !== null && !propFits(prop, value)) at(key, [`${definition.label}'s ${prop.label} (${key}) takes ${expected(prop)} - got ${JSON.stringify(value)}.`]);
  }
  if (config.roles !== undefined && config.roles !== null) {
    if (!isRecord(config.roles)) {
      at("roles", ["roles must map a role to its column (or columns)."]);
    } else {
      for (const [key, value] of Object.entries(config.roles)) {
        const role = definition.roles[key];
        if (!role) {
          at(`roles.${key}`, [`${definition.label} has no role "${key}" - its roles: ${Object.keys(definition.roles).join(", ") || "none"}.`]);
          continue;
        }
        if (value === null) continue;
        const ok = role.multiple ? Array.isArray(value) && value.every((v) => typeof v === "string") : typeof value === "string";
        if (!ok) at(`roles.${key}`, [`${definition.label}'s ${role.label} (roles.${key}) takes ${role.multiple ? "a list of column names" : "a column name"} - got ${JSON.stringify(value)}.`]);
      }
    }
  }
  return issues;
}

function cardPropErrors(label: string, key: string, prop: DashboardWidgetProp, value: unknown): string[] {
  if (value !== null && !propFits(prop, value)) return [`${label}'s ${prop.label} (${key}) takes ${expected(prop)} - got ${JSON.stringify(value)}.`];
  if (typeof value === "string" && value.length > 200) return [`${label}'s ${prop.label} (${key}) is at most 200 characters.`];
  return [];
}

/** A presentation widget's config (D3): its page widget's own props and formulas, its title's, its style and card. */
function presentationIssues(definition: DashboardWidgetDefinition, page: WidgetName, config: Record<string, unknown>, card: Readonly<Record<string, DashboardWidgetProp>>): DashboardConfigIssue[] {
  const own = pageProps(page);
  const issues: DashboardConfigIssue[] = [];
  const at = (path: string, messages: string[]) => issues.push(...messages.map((message) => ({ path, message })));
  const keys = ["props", "bindings", "style", ...Object.keys(card)];
  for (const [key, value] of Object.entries(config)) {
    if (key === "style") at("style", styleErrors(definition.label, value));
    else if (card[key]) at(key, cardPropErrors(definition.label, key, card[key]!, value));
    else if (key !== "props" && key !== "bindings") at(key, [`${definition.label} has no "${key}" - its config takes: ${keys.join(", ")} (its props go in props).`]);
  }
  if (config.props !== undefined && config.props !== null && !isRecord(config.props)) at("props", [`${definition.label}'s props must be an object.`]);
  const literal = isRecord(config.props) ? config.props : {};
  for (const key of Object.keys(literal).filter((k) => !(k in own))) {
    at(`props.${key}`, [`${definition.label} has no prop "${key}" - its props: ${Object.keys(own).join(", ")}.`]);
  }
  const bindings = isRecord(config.bindings) ? config.bindings : {};
  const formulaProps = Object.entries(own).filter(([, p]) => p.binding === "formula").map(([k]) => k);
  at("bindings", bindingErrors(definition.label, config.bindings, (k) => k === DASHBOARD_TITLE_BINDING || formulaProps.includes(k), [DASHBOARD_TITLE_BINDING, ...formulaProps]));
  if (issues.length) return issues;
  // The page's own check of each value and binding - the same messages a page gives.
  const pageBindings = Object.fromEntries(Object.entries(bindings).filter(([k]) => k !== DASHBOARD_TITLE_BINDING));
  at("props", validateWidgetControlConfig({ widget: page, props: literal, bindings: pageBindings, emits: {} }));
  if (page === "TFrame") {
    const checked = checkFrameUrlTemplate(literal.url, DASHBOARD_FRAME_URL_TOKEN, "{{vars.…}}, {{user.…}} and {{row.…}}");
    if ("problem" in checked) at("props.url", [checked.problem]);
  }
  return issues;
}

/**
 * A widget's Styles (`config.style`, Dashboards.md §5): the page catalog's common style block - its
 * card's spacing, alignment, background, border, radius and shadow - each one of its listed values.
 */
function styleErrors(label: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!isRecord(value)) return [`${label}'s style must be an object.`];
  const errors: string[] = [];
  const props = COMMON_STYLE_PROPS as Readonly<Record<string, { label: string; options?: readonly string[] }>>;
  for (const [key, setting] of Object.entries(value)) {
    const prop = props[key];
    if (!prop) errors.push(`${label}'s style has no "${key}" - its keys: ${Object.keys(props).join(", ")}.`);
    else if (setting !== null && !(typeof setting === "string" && (prop.options ?? []).includes(setting))) errors.push(`${label}'s style.${key} is one of ${(prop.options ?? []).join(", ")} - got ${JSON.stringify(setting)}.`);
  }
  return errors;
}

/** `config` without the props and roles its type doesn't have - what a widget saves on a type change. */
export function knownDashboardConfig(type: DashboardWidgetType, config: Record<string, unknown>): Record<string, unknown> {
  const definition = DASHBOARD_WIDGET_CATALOG[type] as DashboardWidgetDefinition;
  const card = dashboardCardProps(type);
  if (definition.page) return Object.fromEntries(Object.entries(config).filter(([key]) => key === "props" || key === "bindings" || key === "style" || key in card));
  const known: Record<string, unknown> = Object.fromEntries(Object.entries(config).filter(([key]) => key in definition.props || key === "style" || key in card));
  // A data widget binds its title only.
  const title = isRecord(config.bindings) ? config.bindings[DASHBOARD_TITLE_BINDING] : undefined;
  if (title !== undefined) known.bindings = { [DASHBOARD_TITLE_BINDING]: title };
  if (isRecord(config.roles)) {
    const roles = Object.fromEntries(Object.entries(config.roles).filter(([key]) => key in definition.roles));
    if (Object.keys(roles).length > 0) known.roles = roles;
  }
  return known;
}

/**
 * A config carried over to another type (Dashboards.md §10, D2): the roles it keeps, renamed to their
 * equivalent (Category ↔ Label, Values ↔ Value), and the props both types have.
 */
export function convertDashboardConfig(from: DashboardWidgetType, to: DashboardWidgetType, config: Record<string, unknown>): Record<string, unknown> {
  const roles = isRecord(config.roles) ? { ...config.roles } : {};
  const target = DASHBOARD_WIDGET_CATALOG[to] as DashboardWidgetDefinition;
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const carried: Record<string, unknown> = {};
  const take = (key: string, value: unknown) => {
    if (value === undefined || value === null || !(key in target.roles)) return;
    carried[key] = target.roles[key]!.multiple ? (Array.isArray(value) ? value : [value]) : first(value);
  };
  for (const [key, value] of Object.entries(roles)) take(key, value);
  // Equivalents, where the target lacks the same id.
  if (roles.category !== undefined && !("category" in target.roles)) take("label", roles.category);
  if (roles.label !== undefined && !("label" in target.roles)) take("category", roles.label);
  if (roles.values !== undefined && !("values" in target.roles)) take("value", roles.values);
  if (roles.value !== undefined && !("value" in target.roles)) take("values", roles.value);
  const known = knownDashboardConfig(to, { ...config, roles: undefined });
  return Object.keys(carried).length > 0 ? { ...known, roles: carried } : known;
}

/** `config`'s props with each unset one at its default - what a widget renders with. */
export function dashboardWidgetProps(type: DashboardWidgetType, config: Record<string, unknown>): Record<string, unknown> {
  const definition = DASHBOARD_WIDGET_CATALOG[type] as DashboardWidgetDefinition;
  const props: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(definition.props)) {
    const value = config[key];
    if (value !== undefined && value !== null) props[key] = value;
    else if (prop.default !== undefined) props[key] = prop.default;
  }
  return props;
}

/** A result column as the roles see it: its name, PostgreSQL type, and what's known of its origin. */
export interface DashboardResultColumn {
  name: string;
  dataType: string;
  fileReference?: boolean;
}

/** How a role was filled - by the config, or by its default rule (and which). */
export interface DashboardRoleAssignment {
  columns: string[];
  /** Chosen in `config.roles`, or picked by the role's default (`first`/`all`). */
  source: "config" | "default";
  /** A default's rule (DM3): the first column of a kind the role takes, or every one - by position, never by name. */
  rule?: "first-of-kind" | "all-of-kind";
}

export interface DashboardRolesResult {
  /** Each role's columns - an unfilled optional role is absent. */
  roles: Record<string, DashboardRoleAssignment>;
  /** One per problem: the role, what it takes, what the query returned. */
  errors: string[];
}

const KIND_LABEL: Record<DashboardValueKind, string> = { number: "a number", time: "a date or time", category: "a category", point: "a point", file: "a file" };

/**
 * Each role's columns for a query's result (Dashboards.md §5.1): what `config.roles` assigns, checked -
 * a column the query returns, of a kind the role takes (by hand, its `manual` kinds too) - else its default by kind and
 * position: the first (or every) column of a kind it takes, never by name, never a `_` column, never one another role
 * holds. Errors name the role, what it takes and what the query returned.
 */
export function resolveDashboardRoles(type: DashboardWidgetType, config: Record<string, unknown>, columns: readonly DashboardResultColumn[]): DashboardRolesResult {
  const definition = DASHBOARD_WIDGET_CATALOG[type] as DashboardWidgetDefinition;
  const assigned = isRecord(config.roles) ? config.roles : {};
  const kinds = new Map(columns.map((c) => [c.name, dashboardValueKind(c)]));
  const returned = columns.length ? columns.map((c) => `${c.name} (${c.dataType})`).join(", ") : "no columns";
  const roles: Record<string, DashboardRoleAssignment> = {};
  const errors: string[] = [];
  const taken = new Set<string>();
  const takes = (role: DashboardRole) => [...role.accepts, ...(role.manual ?? [])];
  const describe = (role: DashboardRole) => takes(role).map((k) => KIND_LABEL[k]).join(" or ");

  // What the config chose first - a default never takes a column a chosen role holds.
  for (const [id, role] of Object.entries(definition.roles)) {
    const value = assigned[id];
    if (value === undefined || value === null) continue;
    const names = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");
    const valid: string[] = [];
    for (const name of names) {
      const kind = kinds.get(name);
      if (kind === undefined) errors.push(`${definition.label}'s ${role.label}: the query returns no column "${name}" - it returns ${returned}.`);
      else if (!takes(role).includes(kind)) errors.push(`${definition.label}'s ${role.label}: "${name}" is ${KIND_LABEL[kind]} - ${role.label} takes ${describe(role)}.`);
      else valid.push(name);
    }
    if (valid.length > 0) {
      roles[id] = { columns: valid, source: "config" };
      for (const name of valid) taken.add(name);
    }
  }
  // Then each role's default, in the contract's order.
  for (const [id, role] of Object.entries(definition.roles)) {
    if (roles[id] || (assigned[id] !== undefined && assigned[id] !== null) || role.default === "none") continue;
    const candidates = columns.filter((c) => !c.name.startsWith("_") && !taken.has(c.name) && role.accepts.includes(kinds.get(c.name)!)).map((c) => c.name);
    const picked = role.default === "all" ? candidates : candidates.slice(0, 1);
    if (picked.length === 0) continue;
    roles[id] = { columns: picked, source: "default", rule: role.default === "all" ? "all-of-kind" : "first-of-kind" };
    if (role.default === "first") taken.add(picked[0]!);
  }
  for (const [id, role] of Object.entries(definition.roles)) {
    if (role.required && !roles[id] && !errors.some((e) => e.startsWith(`${definition.label}'s ${role.label}:`))) {
      errors.push(`${definition.label} needs ${role.multiple ? "at least one column" : "a column"} of ${describe(role)} for ${role.label} - the query returns ${returned}.`);
    }
  }
  // A map: a point, or latitude and longitude together.
  if (type === "MAP" && !roles.location && !(roles.latitude && roles.longitude)) {
    errors.push(`Map needs a point column for Location, or a Latitude and a Longitude chosen by hand - the query returns ${returned}.`);
  }
  return { roles, errors };
}

/**
 * What a widget's resolved roles can't draw beyond each role's own check (tanda 3): a COMBO needs two or more value
 * columns, in wide format (D11). A fixed code, a sentence a viewer reads - null when it draws.
 */
export function dashboardRolesProblem(type: DashboardWidgetType, config: Record<string, unknown>, roles: Record<string, DashboardRoleAssignment>): { code: "DASHBOARD_COMBO_NEEDS_TWO_VALUES"; message: string } | null {
  if (type === "COMBO") {
    const assigned = isRecord(config.roles) ? config.roles : {};
    if ((roles.values?.columns.length ?? 0) < 2 || (assigned.series !== undefined && assigned.series !== null)) {
      return { code: "DASHBOARD_COMBO_NEEDS_TWO_VALUES", message: "Combo chart needs at least two columns in Values - for a series per value of a column, use a Bar chart." };
    }
  }
  return null;
}

/**
 * The auto-refresh intervals a dashboard may use, in seconds
 * (Dashboards.md §9.4) - the same list as the column's CHECK.
 * 30 seconds at the least, so widget SQL load stays bounded; null = off.
 */
export const DASHBOARD_REFRESH_INTERVALS = [
  { seconds: 30, label: "Every 30 seconds" },
  { seconds: 60, label: "Every minute" },
  { seconds: 300, label: "Every 5 minutes" },
  { seconds: 900, label: "Every 15 minutes" },
  { seconds: 3600, label: "Every hour" },
] as const;

export type DashboardRefreshInterval = (typeof DASHBOARD_REFRESH_INTERVALS)[number]["seconds"];

export function isDashboardRefreshInterval(value: unknown): value is DashboardRefreshInterval {
  return DASHBOARD_REFRESH_INTERVALS.some((interval) => interval.seconds === value);
}
