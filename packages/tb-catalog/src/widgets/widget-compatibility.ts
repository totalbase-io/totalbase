import { WIDGET_NAMES, widgetDefinition, type ValueKind, type WidgetName } from "./widget-catalog.js";
import { columnValueKind, type ForeignKeyTarget } from "./widget-inference.js";

/**
 * The widgets that can edit a column - every catalog widget whose `accepts`
 * lists the column's value kind, in catalog order. Adding a widget to
 * WIDGET_CATALOG with an `accepts` is all it takes to offer it here
 * (DataViews.md §14.3).
 */
export function compatibleWidgets(dataType: string, foreignKey: ForeignKeyTarget | null): WidgetName[] {
  const kind = columnValueKind(dataType, foreignKey);
  return WIDGET_NAMES.filter((name) => widgetDefinition(name).accepts?.includes(kind));
}

/** Every widget that can edit a column (it has an `accepts`) - the choices when a column's type isn't known. */
export const COLUMN_WIDGET_NAMES: readonly WidgetName[] = WIDGET_NAMES.filter((name) => widgetDefinition(name).accepts !== undefined);

export function isColumnWidgetName(name: string): name is WidgetName {
  return (COLUMN_WIDGET_NAMES as readonly string[]).includes(name);
}

/** The inputs that can edit a column of `kind` in a form - its presentation's `widget` is one of them (§15.2). */
export function columnInputWidgets(kind: ValueKind): WidgetName[] {
  return WIDGET_NAMES.filter((name) => widgetDefinition(name).formField === true && widgetDefinition(name).accepts?.includes(kind));
}
