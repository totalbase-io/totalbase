import { TotalBaseError } from "@totalbase/errors";
import { validateFrameUrlTemplate } from "./frame-url.js";
import {
  isWidgetName,
  PAGE_FOOTER_SLOT,
  PAGE_FOOTER_WIDGETS,
  PAGE_HEADER_SLOT,
  PAGE_HEADER_WIDGETS,
  slotBase,
  validateRecordConfig,
  validateVariables,
  validateWidgetControlConfig,
  widgetDefinition,
  type VariableRef,
  type WidgetName,
} from "@totalbase/tb-catalog";

/**
 * Placed widgets (`kind = 'WIDGET'` fields) and a CUSTOM DataView's
 * variables - DataViews.md §8, §9, §13.2. The
 * widget catalog and the variable catalog (@totalbase/tb-catalog) are the
 * rules; this file applies them to what the Admin API stores, so the
 * Design form and a direct API call are held to the same checks.
 * Validation is for the author, not security: the Data API and the
 * function/workflow routes still enforce every permission at run time.
 */

/** What a WIDGET field's `config` holds - its widget lives in the `widget` column. */
export interface WidgetFieldConfig {
  props?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  emits?: Record<string, unknown>;
  /** The parent widget's slot it lives in (`parent` names the parent). */
  slot?: string;
  /** A form field's input that follows its column's input (`columnFormInput`, DataViews.md §15.2) - until one of its own is picked. */
  fromColumn?: boolean;
}

/** The variables a DataView's `view_config` defines, as widget bindings need them. */
export function variableRefs(viewConfig: Record<string, unknown> | null | undefined): VariableRef[] {
  const variables = viewConfig?.variables;
  if (!Array.isArray(variables)) return [];
  return variables.flatMap((v) =>
    v && typeof v === "object" && typeof v.name === "string" && (v.kind === "VALUE" || v.kind === "RESOURCE" || v.kind === "CALL")
      ? [{ name: v.name, kind: v.kind }]
      : [],
  );
}

/** Throws DATAVIEW_VARIABLES_INVALID with every problem, one per line. */
export function assertVariablesValid(variables: unknown): void {
  const errors = validateVariables(variables);
  if (errors.length > 0) throw new TotalBaseError("DATAVIEW_VARIABLES_INVALID", errors.join("\n"));
}

/**
 * The DataView a widget's config points at (a Detail's), for the field's
 * `related_dataview` - a foreign key, so PostgreSQL keeps that DataView from
 * being deleted while a page shows it. Null when it names none.
 */
export function widgetRelatedDataview(widget: WidgetName, config: WidgetFieldConfig): string | null {
  const props = config.props ?? {};
  for (const [name, prop] of Object.entries(widgetDefinition(widget).props)) {
    if (prop.editor === "dataview" && typeof props[name] === "string" && props[name] !== "") return props[name] as string;
  }
  return null;
}

/** The Dashboard a widget's config names (an embedded Dashboard's `dashboard` prop) - the server keeps it as `related_dashboard`, a foreign key. */
export function widgetRelatedDashboard(widget: WidgetName, config: WidgetFieldConfig): string | null {
  const props = config.props ?? {};
  for (const [name, prop] of Object.entries(widgetDefinition(widget).props)) {
    if (prop.editor === "dashboard" && typeof props[name] === "string" && props[name] !== "") return props[name] as string;
  }
  return null;
}

/** Throws DATAVIEW_VARIABLES_INVALID when the page's record settings (`view_config.record`) are wrong. */
export function assertRecordConfigValid(record: unknown): void {
  const errors = validateRecordConfig(record);
  if (errors.length > 0) throw new TotalBaseError("DATAVIEW_VARIABLES_INVALID", errors.join("\n"));
}

export function assertWidgetName(widget: unknown): asserts widget is WidgetName {
  if (typeof widget !== "string" || !isWidgetName(widget)) {
    throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", `Unknown widget: ${String(widget)}`);
  }
}

/** Throws DATAVIEW_WIDGET_INVALID when the config doesn't fit the widget or the variables. */
export function assertWidgetConfigValid(widget: WidgetName, config: WidgetFieldConfig, variables: readonly VariableRef[], ownOrigin?: string): void {
  if (config.slot !== undefined && typeof config.slot !== "string") {
    throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", "A widget's slot is a slot name.");
  }
  const errors = validateWidgetControlConfig(
    { widget, props: config.props ?? {}, bindings: config.bindings ?? {}, emits: config.emits ?? {} },
    variables,
  );
  if (errors.length > 0) throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", errors.join("\n"));
  // A Frame's URL is a template whose site is never data (frame-url.ts); `ownOrigin` - the instance's - is never framed.
  if (widget === "TFrame") validateFrameUrlTemplate(config.props?.url, ownOrigin);
}

/**
 * A widget placed in a slot needs a parent widget that has it. `parent`
 * is the parent field row (null for the canvas root); `slot` must be set
 * exactly when there is a parent - but for a CUSTOM page's header
 * (`PAGE_HEADER_SLOT`), which takes buttons and menus only, and its footer
 * (`PAGE_FOOTER_SLOT`), which takes buttons, menus, text, badges and a Box.
 * A record form's page has neither. A slot that holds an input (a form
 * field's) takes only an input widget.
 */
export function assertWidgetPlacement(parent: { kind: string; widget: string | null } | null, slot: string | undefined, widget: WidgetName, viewType: string): void {
  if (!parent) {
    if (slot === undefined) return;
    if ((slot !== PAGE_HEADER_SLOT && slot !== PAGE_FOOTER_SLOT) || viewType !== "CUSTOM") {
      throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", "A widget on the canvas itself has no slot - only a CUSTOM page has a header and a footer.");
    }
    if (slot === PAGE_HEADER_SLOT && !PAGE_HEADER_WIDGETS.includes(widget)) {
      throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", `The page header takes buttons and menus, not a ${widgetDefinition(widget).label}.`);
    }
    if (slot === PAGE_FOOTER_SLOT && !PAGE_FOOTER_WIDGETS.includes(widget)) {
      throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", `The page footer takes buttons, menus, text, badges and boxes, not a ${widgetDefinition(widget).label}.`);
    }
    return;
  }
  if (parent.kind !== "WIDGET" || !parent.widget || !isWidgetName(parent.widget)) {
    throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", "A widget can only be placed inside another widget.");
  }
  const slots = widgetDefinition(parent.widget).slots;
  // A per-item slot is one area per item (`content:tab1`); any other slot is itself.
  const base = slot === undefined ? undefined : slotBase(slot);
  const perItem = base !== undefined && base in slots ? slots[base]!.perItem === true : false;
  if (slot === undefined || base === undefined || !(base in slots) || perItem !== (slot !== base) || slot.endsWith(":")) {
    const names = Object.keys(slots);
    throw new TotalBaseError(
      "DATAVIEW_WIDGET_SLOT_INVALID",
      names.length === 0
        ? `${widgetDefinition(parent.widget).label} has no area to place widgets in.`
        : `${widgetDefinition(parent.widget).label} has no slot "${String(slot)}" - its slots: ${names.join(", ")}.`,
    );
  }
  if (slots[base]!.holds === "input" && !widgetDefinition(widget).formField) {
    throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", `${widgetDefinition(parent.widget).label}'s ${slots[base]!.label} holds an input, not a ${widgetDefinition(widget).label}.`);
  }
}
