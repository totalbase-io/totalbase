/**
 * The shapes of a dashboard widget's structured props (Specification_Dashboards.md §5.1, DB20): an object, a list,
 * a map by name, a choice of forms - checked at every level by `shapeErrors` (shape.ts), a refusal naming its path
 * ("series.facturado has no "colour" - it takes: label, color, type, axis, displayFormat").
 */

import { CELL_ALIGNS, CELL_FONT_SIZES, COLUMN_LINK_TYPES, PALETTE_COLORS } from "../columns/column-presentation.js";
import { WIDGET_COLORS } from "../widgets/widget-catalog.js";
import type { Shape } from "@totalbase/shared";

// --- The shapes ------------------------------------------------------------------

const TEXT: Shape = { type: "text", max: 200 };
const FORMAT: Shape = { type: "text", max: 64 };
const PALETTE: Shape = { type: "enum", options: PALETTE_COLORS };

/** A column's total in a TABLE's footer row (D28) - the DataView grid's vocabulary, computed by PostgreSQL. */
export const DASHBOARD_TOTAL_KINDS = ["sum", "avg", "min", "max", "count"] as const;

/** A TABLE's column settings (`columnSettings.<column>`, DB19): a table column's presentation, hidden, its total. */
export const TABLE_COLUMN_SETTINGS_SHAPE: Shape = {
  type: "map",
  key: "column",
  of: {
    type: "object",
    fields: {
      label: TEXT,
      shortLabel: { type: "text", max: 32 },
      displayFormat: FORMAT,
      emptyText: { type: "text", max: 64 },
      booleanLabels: { type: "object", fields: { true: { type: "text", max: 32 }, false: { type: "text", max: 32 } } },
      linkType: { type: "enum", options: COLUMN_LINK_TYPES },
      options: { type: "map", key: "value", of: { type: "object", fields: { label: { type: "text", max: 64 }, color: { type: "enum", options: WIDGET_COLORS }, icon: { type: "text", max: 64 } } } },
      align: { type: "enum", options: CELL_ALIGNS },
      fontSize: { type: "enum", options: CELL_FONT_SIZES },
      bold: { type: "boolean" },
      italic: { type: "boolean" },
      mono: { type: "boolean" },
      underline: { type: "boolean" },
      strike: { type: "boolean" },
      color: PALETTE,
      background: PALETTE,
      hidden: { type: "boolean" },
      total: { type: "enum", options: DASHBOARD_TOTAL_KINDS },
    },
  },
};

export const SERIES_TYPES = ["bar", "line", "area"] as const;
export const SERIES_AXES = ["left", "right"] as const;

/** A chart's series (D4), by value column - or, in long format, by a value of the Series column. */
export const SERIES_SHAPE: Shape = {
  type: "map",
  key: "column or Series value",
  of: {
    type: "object",
    fields: { label: TEXT, color: PALETTE, type: { type: "enum", options: SERIES_TYPES }, axis: { type: "enum", options: SERIES_AXES }, displayFormat: FORMAT },
  },
};

const VALUE_AXIS: Shape = {
  type: "object",
  fields: { title: TEXT, min: { type: "number" }, max: { type: "number" }, log: { type: "boolean" }, displayFormat: FORMAT },
};
/** A chart's axes (D4), by role - the category axis, the value axis and the right one (`value2`). */
export const AXES_SHAPE: Shape = {
  type: "object",
  fields: { category: { type: "object", fields: { title: TEXT } }, value: VALUE_AXIS, value2: VALUE_AXIS },
};

const XY_AXIS: Shape = {
  type: "object",
  fields: { title: TEXT, min: { type: "number" }, max: { type: "number" }, log: { type: "boolean" }, displayFormat: FORMAT },
};
/** A scatter's axes (tanda 3, D16), by role: x and y. */
export const AXES_XY_SHAPE: Shape = { type: "object", fields: { x: XY_AXIS, y: XY_AXIS } };

/** A pivot's aggregate per value column (D17) - required, no default: sum, avg, min, max or count. */
export const AGGREGATES_SHAPE: Shape = { type: "map", key: "value column", of: { type: "enum", options: DASHBOARD_TOTAL_KINDS } };
/** A pivot's rows ordered by a value's total (D17). */
export const PIVOT_SORT_SHAPE: Shape = {
  type: "object",
  fields: { value: { type: "text", max: 63 }, direction: { type: "enum", options: ["ASC", "DESC"] } },
  required: ["value"],
};

/** A number from the widget's row (`{column}`) or a dashboard variable (`{variable}`) - resolved on the server (D5). */
const COLUMN_REF: Shape = { type: "object", fields: { column: { type: "text", max: 63 } }, required: ["column"] };
const VARIABLE_REF: Shape = { type: "object", fields: { variable: { type: "text", max: 32 } }, required: ["variable"] };
export const DASHBOARD_VALUE_SOURCE: Shape = { type: "oneOf", label: "a number, {column} or {variable}", forms: [{ type: "number" }, COLUMN_REF, VARIABLE_REF] };

/**
 * Thresholds (D5): an ordered list - the first, without `from`, the base color; each next one from its value up. The
 * same shape alerts read (stage 5): plain data, not a drawing.
 */
export const THRESHOLDS_SHAPE: Shape = {
  type: "list",
  max: 10,
  of: { type: "object", fields: { from: DASHBOARD_VALUE_SOURCE, color: PALETTE, label: { type: "text", max: 64 } }, required: ["color"] },
};

export const REFERENCE_STATISTICS = ["average", "min", "max", "median"] as const;
/** Reference lines and bands on a chart's value axis (D5). */
export const REFERENCES_SHAPE: Shape = {
  type: "list",
  max: 10,
  of: {
    type: "oneOf",
    label: 'a line {type: "line", value} or a band {type: "band", from, to}',
    tag: "type",
    forms: [
      {
        type: "object",
        fields: {
          type: { type: "enum", options: ["line"] },
          value: { type: "oneOf", label: "a number, average, min, max, median, {column} or {variable}", forms: [{ type: "number" }, { type: "enum", options: REFERENCE_STATISTICS }, COLUMN_REF, VARIABLE_REF] },
          label: { type: "text", max: 64 },
          color: PALETTE,
          series: { type: "text", max: 63 },
          axis: { type: "enum", options: ["x", "y"] },
        },
        required: ["value"],
      },
      {
        type: "object",
        fields: { type: { type: "enum", options: ["band"] }, from: DASHBOARD_VALUE_SOURCE, to: DASHBOARD_VALUE_SOURCE, label: { type: "text", max: 64 }, color: PALETTE },
        required: ["from", "to"],
      },
    ],
  },
};

/** A formula over the clicked mark's row and the variables - `{{row.x}}`, `{{vars.x}}` (D6). */
const FORMULA: Shape = { type: "text", max: 500 };
export const CLICK_ACTIONS = ["FILTER", "DATAVIEW", "DASHBOARD", "RECORD", "URL"] as const;
const HINT: Shape = { type: "text", max: 100 };
/** What a click on a widget's mark does (D6) - one action, its values formulas, its targets by id. */
export const CLICK_SHAPE: Shape = {
  type: "oneOf",
  label: "an action: FILTER, DATAVIEW, DASHBOARD, RECORD or URL",
  tag: "action",
  forms: [
    { type: "object", fields: { action: { type: "enum", options: ["FILTER"] }, variable: { type: "text", max: 32 }, value: FORMULA, hint: HINT }, required: ["variable", "value"] },
    { type: "object", fields: { action: { type: "enum", options: ["DATAVIEW"] }, dataview: { type: "text", max: 36 }, filter: { type: "any" }, hint: HINT }, required: ["dataview"] },
    {
      type: "object",
      fields: { action: { type: "enum", options: ["DASHBOARD"] }, dashboard: { type: "text", max: 36 }, variables: { type: "map", key: "variable", of: FORMULA }, tab: { type: "text", max: 32 }, hint: HINT },
      required: ["dashboard"],
    },
    { type: "object", fields: { action: { type: "enum", options: ["RECORD"] }, dataview: { type: "text", max: 36 }, pk: FORMULA, hint: HINT }, required: ["dataview", "pk"] },
    { type: "object", fields: { action: { type: "enum", options: ["URL"] }, url: { type: "text", max: 2000 }, newTab: { type: "boolean" }, inEmbeds: { type: "boolean" }, hint: HINT }, required: ["url"] },
  ],
};
