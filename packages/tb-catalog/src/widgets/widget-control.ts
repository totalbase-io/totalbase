import { distinct, isRecord, isUuid, shapeErrors, type Shape } from "@totalbase/shared";
import type { VariableKind } from "./variable-catalog.js";
import { COMPUTED_COLUMN_TYPES, EMBED_ACTIONS, EMBED_TOOL_DEFAULTS, WIDGET_COLORS, WIDGET_CATALOG, WIDGET_ITEM_FORMULAS, commonWidgetProps, isWidgetName, widgetDefinition, type WidgetName, type WidgetProp } from "./widget-catalog.js";
import { authorPattern } from "../columns/regex-patterns.js";
import { TABLE_COLUMN_PRESENTATION_KEYS } from "../columns/column-presentation.js";
import { LIST_VIEW_TYPES } from "../dataviews/dataview-features.js";

/**
 * What a control placed on a canvas stores (DataViews.md §9, §13.2):
 * the widget, its literal props, the props bound to something
 * else, and the Code function each emit calls. Lives in a control's
 * `dataviews_fields.config`; read by the Design inspector, the runtime
 * renderer and the server's publish validation alike.
 */
export interface WidgetControlConfig {
  widget: WidgetName;
  /** Literal values, by Nuxt UI prop name. A prop left out keeps Nuxt UI's own default. */
  props: Record<string, unknown>;
  /** Props bound to a formula or a variable instead - a binding wins over a literal. */
  bindings: Record<string, WidgetPropBinding>;
  /** Emit name → the Code function it calls. */
  emits: Record<string, string>;
}

/** DataViews.md §9.2: a formula over variables/slot props, or a variable itself (data binding). */
export type WidgetPropBinding = { kind: "formula"; formula: string } | { kind: "variable"; variable: string };


/** The variables a page defines, as far as a control's bindings need to know them. */
export interface VariableRef {
  name: string;
  kind: VariableKind;
}

/** The variable kind a data-bound prop accepts (DataViews.md §9.2). */
export function variableKindForProp(prop: WidgetProp): VariableKind | null {
  if (prop.binding === "value") return "VALUE";
  if (prop.binding === "resource") return "RESOURCE";
  return null;
}

/**
 * A display template (`{{code}} - {{name}}`, a foreign key's Template in
 * Columns) as the formula a per-option field takes: its text quoted, its
 * fields joined with `+` - `{{code}} + " - " + {{name}}`. Two fields side by
 * side start from `""`, so numbers join as text instead of adding up.
 */
export function templateFormula(template: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)) {
    if (match.index > last) parts.push(JSON.stringify(template.slice(last, match.index)));
    parts.push(`{{${match[1]}}}`);
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push(JSON.stringify(template.slice(last)));
  if (parts.length > 1 && parts[0]!.startsWith("{{") && parts[1]!.startsWith("{{")) parts.unshift('""');
  return parts.join(" + ");
}

/** A newly placed control: every prop at Nuxt UI's default, a label where the component has one. */
export function newWidgetControlConfig(widget: WidgetName): WidgetControlConfig {
  const entry = WIDGET_CATALOG[widget];
  const props: Record<string, unknown> = { ...(widgetDefinition(widget).defaults ?? {}) };
  if ("label" in entry.props) props.label = entry.label;
  return { widget, props, bindings: {}, emits: {} };
}

/**
 * Every problem with a stored config, as messages for the author - empty
 * when it is valid. Checks names against the catalog, literal values
 * against each prop's editor, and bindings against the prop's binding and,
 * when `variables` is given, against the page's variables. Validation is
 * for the author, not security (DataViews.md §13.2): the Data API and the
 * function/workflow routes still enforce every permission at run time.
 */
export function validateWidgetControlConfig(config: unknown, variables?: readonly VariableRef[]): string[] {
  if (!isRecord(config)) return ["The control has no configuration."];
  const widget = config.widget;
  if (typeof widget !== "string" || !isWidgetName(widget)) return [`Unknown widget "${String(widget)}".`];
  const entry = widgetDefinition(widget);
  const catalogProps: Readonly<Record<string, WidgetProp>> = { ...entry.props, ...commonWidgetProps(widget) };
  const catalogEmits = entry.emits;
  const errors: string[] = [];

  for (const [name, value] of Object.entries(isRecord(config.props) ? config.props : {})) {
    const prop = catalogProps[name];
    if (!prop) errors.push(`${entry.label} has no prop "${name}".`);
    else if (!literalFits(prop, value)) errors.push(`${entry.label}'s ${prop.label} has an invalid value.`);
    // An option's field written as a formula: it names no field, and every option would show nothing (T64).
    else if (prop.binding === "option" && typeof value === "string" && value.includes("{{"))
      errors.push(`${entry.label}'s ${prop.label} names a field of each option - a formula goes in bindings: { "${name}": { "kind": "formula", "formula": ${JSON.stringify(value)} } }.`);
  }

  for (const [name, binding] of Object.entries(isRecord(config.bindings) ? config.bindings : {})) {
    const prop = catalogProps[name];
    if (!prop) {
      errors.push(`${entry.label} has no prop "${name}".`);
      continue;
    }
    if (!isRecord(binding)) {
      errors.push(`${entry.label}'s ${prop.label} has an invalid binding.`);
    } else if (binding.kind === "formula") {
      // An option list's field may be a formula too - evaluated once per option (PropBinding "option") -
      // and an input's Value: a computed input, read only (DataViews.md §9.2).
      const computedInput = prop.binding === "value" && name === "modelValue" && entry.group === "input";
      if (prop.binding !== "formula" && prop.binding !== "option" && !computedInput) errors.push(`${entry.label}'s ${prop.label} can't be bound to a formula.`);
      else if (typeof binding.formula !== "string") errors.push(`${entry.label}'s ${prop.label} has an invalid formula.`);
    } else if (binding.kind === "variable") {
      const kind = variableKindForProp(prop);
      const variable = variables?.find((v) => v.name === binding.variable);
      if (!kind) errors.push(`${entry.label}'s ${prop.label} can't be bound to a variable.`);
      else if (typeof binding.variable !== "string" || (variables && !variable))
        errors.push(`${entry.label}'s ${prop.label} is bound to a variable that doesn't exist.`);
      else if (variable && variable.kind !== kind) errors.push(`${entry.label}'s ${prop.label} needs a ${kind} variable.`);
    } else {
      errors.push(`${entry.label}'s ${prop.label} has an invalid binding.`);
    }
  }

  for (const [name, handler] of Object.entries(isRecord(config.emits) ? config.emits : {})) {
    if (!(name in catalogEmits)) errors.push(`${entry.label} has no event "${name}".`);
    else if (typeof handler !== "string" || handler === "") errors.push(`${entry.label}'s "${name}" event has no function.`);
  }
  return errors;
}

/** A literal prop value fits when its editor's shape has nothing to say about it. */
function literalFits(prop: WidgetProp, value: unknown): boolean {
  return shapeErrors("", literalShape(prop), value).length === 0;
}

const TEXT: Shape = { type: "text" };
const BOOLEAN: Shape = { type: "boolean" };
const COLOR: Shape = { type: "enum", options: WIDGET_COLORS };
const UUID: Shape = { type: "custom", takes: "an id", check: (value) => (isUuid(value) ? null : "takes an id") };
const TEXT_MAP: Shape = { type: "map", of: TEXT };
/** A `{ name: formula }` map with only `names`. */
const formulas = (names: readonly string[]): Shape => ({ type: "object", fields: Object.fromEntries(names.map((name) => [name, TEXT])) });

/** A Table column's settings (`TableColumnSettings`): its known keys, each of its type. */
const TABLE_COLUMN_SETTINGS: Shape = {
  type: "object",
  fields: {
    ...Object.fromEntries(TABLE_COLUMN_PRESENTATION_KEYS.map((key) => [key, TEXT])),
    booleanLabels: { type: "map", of: { type: "any" } },
    options: { type: "map", of: { type: "any" } },
    bold: BOOLEAN,
    italic: BOOLEAN,
    mono: BOOLEAN,
    underline: BOOLEAN,
    strike: BOOLEAN,
    hidden: BOOLEAN,
    colorFormula: TEXT,
  },
};

/** The shape a prop's editor takes as a literal (DataViews.md §9.1). */
function literalShape(prop: WidgetProp): Shape {
  switch (prop.editor) {
    case "boolean":
      return BOOLEAN;
    case "number":
      return { type: "number" };
    case "select":
      return { type: "enum", options: prop.options ?? [] };
    case "color":
      return COLOR;
    case "json":
      return { type: "any" };
    case "dataview":
    case "dashboard":
    case "junction":
      return UUID;
    case "dataviewView":
      return { type: "enum", options: LIST_VIEW_TYPES };
    case "dataviewColumns":
      return { type: "list", of: { type: "text", check: (value) => (value === "" ? "is empty" : null) }, check: distinct("a column") };
    case "image":
      // A file's id, or a URL - https, or the instance's own path (/api/totalbase/table/files/...).
      return { type: "text", check: (value) => (isUuid(value) || /^https?:\/\/\S+$/i.test(value as string) || /^\/[^/]\S*$/.test(value as string) ? null : "is a file's id, a URL or a path") };
    case "dataviewTools":
      return { type: "object", fields: Object.fromEntries(Object.keys(EMBED_TOOL_DEFAULTS).map((key) => [key, BOOLEAN])) };
    case "dataviewAllow":
      return { type: "list", of: { type: "enum", options: EMBED_ACTIONS }, check: distinct("an action") };
    case "dashboardVariables":
    case "attributes":
      return TEXT_MAP;
    case "regex":
      return { type: "text", check: (value) => (authorPattern(value as string) === null ? "doesn't compile" : null) };
    case "tableColumns":
      return { type: "map", key: "column", of: TABLE_COLUMN_SETTINGS };
    case "actions":
      return {
        type: "list",
        of: {
          type: "object",
          fields: { name: { type: "text", check: (value) => ((value as string).trim() === "" ? "is empty" : null) }, icon: TEXT, label: TEXT, formulas: formulas(["disabled", "visible"]) },
          required: ["name"],
        },
        check: distinct("an action", "name"),
      };
    case "computedColumns":
      return {
        type: "list",
        of: {
          type: "object",
          fields: { key: { type: "text", check: (value) => (/^[a-z_][a-z0-9_]*$/.test(value as string) ? null : "is a column name - lowercase letters, digits and _") }, label: TEXT, type: { type: "enum", options: COMPUTED_COLUMN_TYPES }, formula: TEXT },
          required: ["key", "type", "formula"],
        },
        check: distinct("a column", "key"),
      };
    case "items":
      // Items' keys name their areas - never two alike.
      return { type: "list", of: itemShape(prop), check: distinct("an item", "value") };
    default:
      return TEXT;
  }
}

/** A Tabs', an Accordion's or a Dropdown menu's item (`WidgetItem`): only what its prop's `itemFields` give it. */
/** A panel's share of the whole: 0 to 100. */
const PERCENT: Shape = { type: "number", check: (value) => (typeof value === "number" && value >= 0 && value <= 100 ? null : "is a percentage, 0 to 100") };
/** A column's width in the row's 12 columns: 1 to 12. */
const SPAN: Shape = { type: "number", check: (value) => (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12 ? null : "is a width in columns, 1 to 12") };

function itemShape(prop: WidgetProp): Shape {
  const fields = prop.itemFields ?? [];
  return {
    type: "object",
    fields: {
      value: TEXT,
      label: TEXT,
      formulas: formulas(WIDGET_ITEM_FORMULAS.filter((f) => f === "label" || fields.includes(f))),
      ...(fields.includes("icon") ? { icon: TEXT } : {}),
      ...(fields.includes("color") ? { color: COLOR } : {}),
      ...(fields.includes("function") ? { onSelect: TEXT } : {}),
      ...(fields.includes("size") ? { defaultSize: PERCENT } : {}),
      ...(fields.includes("minSize") ? { minSize: PERCENT } : {}),
      ...(fields.includes("collapsible") ? { collapsible: { type: "boolean" } } : {}),
      ...(fields.includes("span") ? { span: SPAN } : {}),
    },
  };
}
