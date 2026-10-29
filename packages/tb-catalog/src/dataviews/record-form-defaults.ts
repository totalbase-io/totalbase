/**
 * How a new list DataView's record form opens when its creator doesn't say (DataViews.md §6.3): past
 * `MANY_FIELDS_THRESHOLD` fields on its own page, else a Sidebar of its default width beside the list. Its fields
 * are always in one column, whichever it is.
 */
export const MANY_FIELDS_THRESHOLD = 10;

export function defaultEditPresentation(fieldCount: number): "PAGE" | "SIDEBAR" {
  return fieldCount > MANY_FIELDS_THRESHOLD ? "PAGE" : "SIDEBAR";
}
