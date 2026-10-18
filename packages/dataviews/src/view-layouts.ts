import { SETTINGS_LAYOUT_KEYS } from "@totalbase/tb-catalog";
import type { Shape } from "@totalbase/shared";

/**
 * Each view's layout in `view_config` (`card_layout`, `map_layout`, ...; Specification_DataViews.md §5): the
 * view that reads it, what in it names a column of the source - a picked column, a formula's `{{column}}` -
 * and its other settings. Defined once: `view-config.ts` checks a layout's shape from it, `broken-references.ts`
 * finds the columns it names.
 */
export interface ViewLayout {
  /** The `view_config` key. */
  key: string;
  /** The view that shows it. */
  view: string;
  /** Settings that pick a column by name. */
  columns: readonly string[];
  /** Settings that are a formula over the row (`{{column}}`). */
  formulas: readonly string[];
  /** Its other settings, each with its shape. */
  settings: Readonly<Record<string, Shape>>;
}

const text: Shape = { type: "text" };
const optionalText: Shape = { type: "optional", of: text };
const boolean: Shape = { type: "boolean" };
const textList: Shape = { type: "list", of: text };
const enumOf = (...options: readonly string[]): Shape => ({ type: "enum", options });
const optional = (of: Shape): Shape => ({ type: "optional", of });

export const VIEW_LAYOUTS: readonly ViewLayout[] = [
  {
    key: "card_layout",
    view: "CARDS",
    columns: [],
    formulas: ["imageFormula", "titleFormula", "descriptionFormula"],
    settings: { imageAspect: optional(enumOf("original", "1:1", "3:4", "4:3", "16:9")), imageFit: optional(enumOf("cover", "contain")), imagePosition: optional(enumOf("top", "center")) },
  },
  {
    key: "map_layout",
    view: "MAP",
    columns: ["pointColumn", "latitudeColumn", "longitudeColumn"],
    formulas: ["nameFormula", "descriptionFormula", "iconFormula", "colorFormula"],
    settings: { defaultIcon: text, defaultColor: optionalText },
  },
  {
    key: "kanban_layout",
    view: "KANBAN",
    columns: ["groupColumn"],
    formulas: ["titleFormula", "descriptionFormula", "imageFormula"],
    settings: { laneOrder: textList, laneOrderColumn: optionalText, laneColorColumn: optionalText, readOnly: boolean },
  },
  {
    key: "calendar_layout",
    view: "CALENDAR",
    columns: ["dateColumn"],
    formulas: ["titleFormula", "descriptionFormula", "colorFormula"],
    settings: { defaultColor: optionalText, weekStartsOn: { type: "number", integer: true, min: 0, max: 6 }, defaultView: enumOf("month", "week", "day", "agenda") },
  },
  {
    key: "gantt_layout",
    view: "GANTT",
    columns: ["startDateColumn", "endDateColumn", "groupColumn", "progressColumn"],
    formulas: ["titleFormula", "descriptionFormula", "colorFormula"],
    settings: { defaultColor: optionalText, laneOrder: textList, laneOrderColumn: optionalText, laneColorColumn: optionalText, defaultZoom: enumOf("day", "week", "month") },
  },
  {
    key: "tree_layout",
    view: "TREE",
    columns: ["parentColumn", "orderColumn"],
    formulas: ["titleFormula", "descriptionFormula", "iconFormula", "colorFormula", "imageFormula"],
    settings: { defaultDisplay: enumOf("tree", "org"), expandLevel: { type: "number", integer: true, min: 0, max: 20 } },
  },
  { key: "settings_layout", view: "SETTINGS", columns: SETTINGS_LAYOUT_KEYS, formulas: [], settings: {} },
];

/** A layout's shape: every column and formula optional text, plus its own settings. */
export function viewLayoutShape(layout: ViewLayout): Shape {
  return {
    type: "object",
    fields: {
      ...Object.fromEntries([...layout.columns, ...layout.formulas].map((key) => [key, optionalText])),
      ...layout.settings,
    },
  };
}
