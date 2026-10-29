/**
 * `view_config.column_sync` - "New table columns" (DataViews.md §4.2), a DataView-level (not per-field) setting
 * deciding what `syncFields()` (dataviews-admin-service.ts) does with a
 * column the underlying table has that this DataView doesn't yet have
 * a field for, and whether the Design form's palette may add one that
 * already exists but was never selected.
 *
 * The chat's own framing (a user asked for this after wondering
 * whether it could double as a way to keep a sensitive column, e.g.
 * salary, out of a DataView - it CANNOT, and the UI copy wherever this
 * is offered must say so plainly): this is a PRESENTATION scope only.
 * A `locked` DataView still returns every column to anyone who queries
 * the underlying table directly (the public Data API, SQL Console, a
 * different DataView over the same table) - nothing here touches
 * `totalbase.permissions`. Real field-level access control is a
 * FieldGrant on a role's permission, not this.
 *
 * - `auto_show` (default - "Add them shown"): a newly-discovered column is
 *   added VISIBLE, and to the generated record form after its last field.
 * - `auto_hide` ("Add them hidden"): added HIDDEN in the list, not to the form.
 * - `locked`: NOT added at all - the DataView's column set is frozen
 *   to whatever it already has. The Design form's own palette (admin
 *   app) additionally refuses to let a builder manually add a
 *   currently-unselected EXISTING column while locked - enforced
 *   client-side only, consistent with this being a presentation
 *   convenience, not a security boundary; nothing server-side needs to
 *   reject it (a direct API PATCH could still flip a field to visible
 *   under a locked DataView - not worth blocking, the same "presentation
 *   only" scope already applies to that path too).
 */
export const COLUMN_SYNC_VALUES = ["auto_show", "auto_hide", "locked"] as const;
export type ColumnSync = (typeof COLUMN_SYNC_VALUES)[number];
const DEFAULT_COLUMN_SYNC: ColumnSync = "auto_show";

export function resolveColumnSync(viewConfig: Record<string, unknown>): ColumnSync {
  const stored = viewConfig.column_sync;
  return (COLUMN_SYNC_VALUES as readonly string[]).includes(stored as string) ? (stored as ColumnSync) : DEFAULT_COLUMN_SYNC;
}
