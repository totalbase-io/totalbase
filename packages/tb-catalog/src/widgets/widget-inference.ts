import type { ValueKind } from "./widget-catalog.js";

/**
 * Which kind of value a column holds (Specification_DataViews.md §14). The
 * widget it gets by default is the column input catalog's (column-inputs.ts:
 * `columnFormInput`), the one rule for a grid column and a form field alike.
 */

/** Just enough of a real foreign key to tell a plain FK apart from one that targets `totalbase.files(id)` specifically. */
export interface ForeignKeyTarget {
  targetSchema: string;
  targetTable: string;
}
export function isFilesForeignKey(foreignKey: ForeignKeyTarget | null): boolean {
  return foreignKey?.targetSchema === "totalbase" && foreignKey.targetTable === "files";
}

/** A numeric PostgreSQL type - MAP's Latitude/Longitude selects reuse the same rule. */
export function isNumericDataType(dataType: string): boolean {
  return /^(integer|bigint|smallint|numeric|real|double precision|decimal|money)/.test(dataType.toLowerCase());
}

/** A `date`/`timestamp`/`timestamptz` column (PostgreSQL reports "timestamp with/without time zone") - CALENDAR's and GANTT's date selects. */
export function isDateDataType(dataType: string): boolean {
  return /^(date|timestamp)/.test(dataType.toLowerCase());
}

/**
 * The kind of value a column holds (`ValueKind`), from its PostgreSQL type
 * and foreign key. A FK to `totalbase.files(id)` is a `file`, not a
 * `relation`: Files has no list route to pick a row from
 * (Specification_Administration.md §10). `time` is distinct from `timestamp` (`\b`),
 * and `date` from both: a day picker on a timestamp would round every pick
 * to midnight.
 */
export function columnValueKind(dataType: string, foreignKey: ForeignKeyTarget | null): ValueKind {
  if (isFilesForeignKey(foreignKey)) return "file";
  if (foreignKey) return "relation";
  const type = dataType.toLowerCase();
  if (type.endsWith("[]")) return "array";
  if (type === "boolean") return "boolean";
  if (type === "json" || type === "jsonb") return "json";
  if (type === "point") return "point";
  // A range (int4range, tstzrange, daterange... - not a multirange, edited as text).
  if (/(?<!multi)range$/.test(type)) return "range";
  if (isNumericDataType(type)) return "number";
  if (/^time\b/.test(type)) return "time";
  if (type === "date") return "date";
  if (/^timestamp/.test(type)) return "timestamp";
  return "text";
}
