import { customActionsProblem, DATAVIEW_FEATURE_KEYS, EMBED_ACTIONS, LIST_VIEW_TYPES } from "@totalbase/tb-catalog";
import { distinct, isRecord, shapeErrors, type Shape } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";
import { parseFilter } from "@totalbase/query-engine";
import { VIEW_LAYOUTS, viewLayoutShape } from "./view-layouts.js";

/** A custom action's condition - the Data API's `where` grammar, checked by its own parser, as deep as a request's may go. */
function filterProblem(where: Record<string, unknown>): string | null {
  try {
    parseFilter(where, { maxFilterDepth: 10, maxRelationDepth: 3 }, 0);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The shape of every `view_config` key an author writes
 * (DataViews.md §2.7): a known key, of its type, with a known
 * value. `frame_url`, `variables` and `record` have validators of their own;
 * `last_attnum` is the server's. A value may be `null` where the admin clears
 * a setting back to its default (an `optional` shape). Each layout's shape
 * comes from `view-layouts.ts`.
 */
const text: Shape = { type: "text" };
const optionalText: Shape = { type: "optional", of: text };
const optionalEnum = (...options: readonly string[]): Shape => ({ type: "optional", of: { type: "enum", options } });
const enumOf = (...options: readonly string[]): Shape => ({ type: "enum", options });
const object: Shape = { type: "map", of: { type: "any" } };

const KEYS: Readonly<Record<string, Shape>> = {
  column_sync: enumOf("auto_show", "auto_hide", "locked"),
  base_where: object,
  default_state: object,
  auto_refresh: optionalText,
  edit_presentation: enumOf("DRAWER", "MODAL", "SIDEBAR", "PAGE"),
  edit_size: optionalEnum("sm", "md", "lg", "xl"),
  edit_side: enumOf("left", "right", "top", "bottom"),
  form_view_mode: enumOf("READ", "UPDATE", "CREATE", "SINGLE"),
  open_with: enumOf("NEW_RECORD", "WAIT"),
  new_record_label: optionalText,
  page_content_width: optionalEnum("narrow", "wide", "full"),
  page_content_align: optionalEnum("left", "center", "right"),
  list_margin: optionalEnum("none", "compact", "normal"),
  header_align: optionalEnum("left", "center", "right"),
  fit_to_screen: { type: "boolean" },
  // What its viewers may do besides reading - only less than their permissions (DataViews.md §5.1).
  allow: { type: "optional", of: { type: "list", of: enumOf(...EMBED_ACTIONS), check: distinct("an action") } },
  map_view: { type: "object", fields: { centerLat: { type: "number" }, centerLng: { type: "number" }, zoom: { type: "number" } } },
  ...Object.fromEntries(VIEW_LAYOUTS.map((layout) => [layout.key, viewLayoutShape(layout)])),
};

/** Validated by their own functions (frame-url.ts, assertVariablesValid, assertRecordConfigValid). */
const VALIDATED_ELSEWHERE = new Set(["frame_url", "variables", "record"]);

/**
 * Throws 422 DATAVIEW_VIEW_CONFIG_INVALID unless every key of `viewConfig`
 * (a whole one on create, a patch's keys on update) is one an author may
 * write, with a value of its shape; `features` holds only the type's own
 * feature keys, each true or false.
 */
export function assertViewConfigShape(viewType: string, viewConfig: Record<string, unknown>): void {
  const isList = (LIST_VIEW_TYPES as readonly string[]).includes(viewType);
  for (const [key, value] of Object.entries(viewConfig)) {
    if (VALIDATED_ELSEWHERE.has(key)) continue;
    if (key === "last_attnum") throw invalid("last_attnum is maintained by the server.");
    if (key === "layouts") {
      // The views a list DataView offers, in order - its view_type the one it opens with.
      if (!isList) throw invalid(`layouts is for a list DataView (${LIST_VIEW_TYPES.join(", ")}), not a ${viewType}.`);
      if (value === null) continue;
      if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && (LIST_VIEW_TYPES as readonly string[]).includes(v))) {
        throw invalid(`layouts must be a list of ${LIST_VIEW_TYPES.join(", ")}.`);
      }
      if (new Set(value).size !== value.length) throw invalid("layouts lists a view twice.");
      continue;
    }
    if (key === "kiosk") {
      // The page alone on screen - no menu, no header - for a totem or a phone used as a reader (DataViews.md §7.3).
      if (viewType !== "CUSTOM") throw invalid(`kiosk is for a CUSTOM page, not a ${viewType}.`);
      if (value !== null && typeof value !== "boolean") throw invalid("kiosk must be true or false.");
      continue;
    }
    if (key === "features") {
      // A list DataView may switch to any of its views: the features of every list type.
      const allowed = isList ? [...new Set(LIST_VIEW_TYPES.flatMap((t) => DATAVIEW_FEATURE_KEYS[t] ?? []))] : DATAVIEW_FEATURE_KEYS[viewType] ?? [];
      if (!isRecord(value)) throw invalid("features must be an object.");
      for (const [feature, on] of Object.entries(value)) {
        if (!allowed.includes(feature)) throw invalid(`features has no "${feature}" for a ${viewType} DataView.`);
        if (typeof on !== "boolean") throw invalid(`features.${feature} must be true or false.`);
      }
      continue;
    }
    if (key === "custom_actions") {
      // Its own actions (DataViews.md §3.7): what each runs, where it shows, when.
      if (value === null) continue;
      const problem = customActionsProblem(value, filterProblem);
      if (problem) throw invalid(`custom_actions${problem.startsWith("[") ? "" : " "}${problem}.`);
      continue;
    }
    const shape = KEYS[key];
    if (!shape) throw invalid(`Unknown view_config key "${key}".`);
    const issue = shapeErrors(key, shape, value)[0];
    if (issue) throw invalid(issue.message);
  }
}

function invalid(message: string): TotalBaseError {
  return new TotalBaseError("DATAVIEW_VIEW_CONFIG_INVALID", message);
}
