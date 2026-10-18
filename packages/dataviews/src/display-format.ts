/**
 * Classifies a real Postgres `data_type` string (the same
 * `information_schema.columns.data_type` shape `columnValueKind`
 * itself reads, see @totalbase/tb-catalog) into the shape a `COLUMN`
 * field's Excel/JasperReports-style display-format feature needs -
 * `displayFormatKind`/`displayFormatTzAware` on `FieldConfig`
 * (apps/admin/app/utils/field-config.ts's own doc comment has the full
 * design).
 *
 * Auto-derived and persisted at field-creation/sync time
 * (dataviews-admin-service.ts's `createFields`/`syncFields`) rather than
 * resolved live - the render-time consumers (the grid's own cell
 * renderer, the record form) never re-introspect the catalog, so this
 * needs to be a stored fact on the field, not a computed one.
 */
export interface DisplayFormatClassification {
  kind: "number" | "date" | "time" | "datetime";
  /** Only `true` for a real `timestamp with time zone` column - a naive `timestamp`/`date`/`time` has no offset to convert. */
  tzAware: boolean;
}

export function classifyColumnDataType(dataType: string): DisplayFormatClassification | null {
  const type = dataType.toLowerCase();
  if (/^(smallint|integer|bigint|numeric|real|double precision|decimal|money)/.test(type)) {
    return { kind: "number", tzAware: false };
  }
  if (type === "date") return { kind: "date", tzAware: false };
  if (/^time\b/.test(type)) return { kind: "time", tzAware: false };
  if (/^timestamp/.test(type)) return { kind: "datetime", tzAware: type.includes("with time zone") };
  return null;
}

/**
 * `true` for a real `json`/`jsonb` column - same "auto-derived and
 * persisted at field-creation/sync time" rule as classifyColumnDataType
 * above, into `config.isJsonColumn` (apps/admin/app/utils/field-
 * config.ts's own doc comment) rather than `displayFormatKind` itself:
 * unlike number/date/time, JSON isn't a display PATTERN concern - it's
 * which runtime WIDGET COMPONENT renders at all (WidgetRenderer.
 * vue's own `isJsonTextareaFor` swaps in `WidgetJsonEditor.vue` instead
 * of a plain `UTextarea`, which would otherwise bind the column's real
 * object/array value straight into a text v-model and show the literal
 * string "[object Object]").
 */
export function isJsonColumnDataType(dataType: string): boolean {
  const type = dataType.toLowerCase();
  return type === "json" || type === "jsonb";
}
