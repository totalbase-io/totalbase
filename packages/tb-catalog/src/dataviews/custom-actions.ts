import { UUID_PATTERN } from "@totalbase/shared";
/**
 * A DataView's own actions (DataViews.md §3.7): a function or a MANUAL workflow run on a row, the open
 * record or a selection - from the row's "⋮", the record's "⋮" or the selection bar, without a page or code. Plain
 * data: the settings write it into `view_config.custom_actions`, the server checks it, the App runs it.
 */

/** Where an action shows. */
export const CUSTOM_ACTION_PLACES = ["row", "record", "selection"] as const;
export type CustomActionPlace = (typeof CUSTOM_ACTION_PLACES)[number];

/** The colors an action's menu item may take - error for one that undoes (Void). */
export const CUSTOM_ACTION_COLORS = ["neutral", "primary", "success", "warning", "error"] as const;

export interface CustomAction {
  /** Its key - stable across edits; names its flag and its result. */
  id: string;
  label: string;
  icon?: string;
  color?: (typeof CUSTOM_ACTION_COLORS)[number];
  /** What it runs: a function resource by id, or a MANUAL workflow by id. */
  target: { kind: "FUNCTION"; resource: string } | { kind: "WORKFLOW"; workflow: string };
  /**
   * What it sends - each argument (a function's parameter, a workflow's input field) a template: `{{column}}` a
   * value of the row, `{{ids}}` the selection's keys (a list), anything else as written. Unset: the row's key as the
   * function's first parameter or the workflow's `id` - a selection's keys as `ids`.
   */
  args?: Record<string, string>;
  places: CustomActionPlace[];
  /** When it shows on a row or a record - a filter (the Data API's grammar), PostgreSQL deciding. Unset: always. */
  where?: Record<string, unknown>;
  /** Asked first: its text (`{{column}}` of the row), and whether it reads as a destructive step. */
  confirm?: { text: string; danger?: boolean };
}

export const MAX_CUSTOM_ACTIONS = 20;
const ID = /^[a-z][a-z0-9_]{0,30}$/;
const ICON = /^i-[a-z0-9]+-[a-z0-9-]+$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What's wrong with a `custom_actions` value - null when it's a list of well-formed actions. `checkWhere` checks a
 * condition's filter in the Data API's grammar (the server's parser; null when it's valid).
 */
export function customActionsProblem(value: unknown, checkWhere?: (where: Record<string, unknown>) => string | null): string | null {
  if (!Array.isArray(value)) return "must be a list";
  if (value.length > MAX_CUSTOM_ACTIONS) return `holds at most ${MAX_CUSTOM_ACTIONS} actions`;
  const ids = new Set<string>();
  for (const [index, action] of value.entries()) {
    const at = `[${index}]`;
    if (!isObject(action)) return `${at} must be an object`;
    const known = new Set(["id", "label", "icon", "color", "target", "args", "places", "where", "confirm"]);
    const unknown = Object.keys(action).find((key) => !known.has(key));
    if (unknown) return `${at} has an unknown key "${unknown}"`;
    if (typeof action.id !== "string" || !ID.test(action.id)) return `${at}.id must be a lowercase identifier (void_invoice)`;
    if (ids.has(action.id)) return `${at}.id "${action.id}" is used twice`;
    ids.add(action.id);
    if (typeof action.label !== "string" || !action.label.trim() || action.label.length > 32) return `${at}.label must be text of 1 to 32 characters`;
    if (action.icon !== undefined && (typeof action.icon !== "string" || !ICON.test(action.icon))) return `${at}.icon must be an icon name (i-lucide-send)`;
    if (action.color !== undefined && !(CUSTOM_ACTION_COLORS as readonly unknown[]).includes(action.color)) return `${at}.color must be one of ${CUSTOM_ACTION_COLORS.join(", ")}`;
    const target = action.target;
    if (!isObject(target)) return `${at}.target must be an object`;
    if (target.kind === "FUNCTION") {
      if (typeof target.resource !== "string" || !UUID_PATTERN.test(target.resource) || Object.keys(target).length !== 2) return `${at}.target must be { kind: "FUNCTION", resource: <its id> }`;
    } else if (target.kind === "WORKFLOW") {
      if (typeof target.workflow !== "string" || !UUID_PATTERN.test(target.workflow) || Object.keys(target).length !== 2) return `${at}.target must be { kind: "WORKFLOW", workflow: <its id> }`;
    } else {
      return `${at}.target.kind must be FUNCTION or WORKFLOW`;
    }
    if (action.args !== undefined) {
      if (!isObject(action.args) || !Object.values(action.args).every((v) => typeof v === "string")) return `${at}.args must map each argument to a text template`;
    }
    if (!Array.isArray(action.places) || action.places.length === 0 || !action.places.every((p) => (CUSTOM_ACTION_PLACES as readonly unknown[]).includes(p)) || new Set(action.places).size !== action.places.length) {
      return `${at}.places must list one or more of ${CUSTOM_ACTION_PLACES.join(", ")}`;
    }
    if (action.where !== undefined) {
      if (!isObject(action.where)) return `${at}.where must be a filter object`;
      const problem = checkWhere?.(action.where);
      if (problem) return `${at}.where ${problem}`;
    }
    if (action.confirm !== undefined) {
      const confirm = action.confirm;
      if (!isObject(confirm) || typeof confirm.text !== "string" || !confirm.text.trim() || confirm.text.length > 200 || Object.keys(confirm).some((k) => k !== "text" && k !== "danger") || (confirm.danger !== undefined && typeof confirm.danger !== "boolean")) {
        return `${at}.confirm must be { text (1 to 200 characters), danger? }`;
      }
    }
  }
  return null;
}
