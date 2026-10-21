import { checkConstraintBounds, checkConstraintDateBounds, checkConstraintPatterns, checkConstraintValues, type ColumnBound, type ColumnPattern, type DateBound } from "@totalbase/tb-catalog";
import { getRelationDetail, type RelationDetail } from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "./context.js";

/**
 * A resource's column catalog as the caller may see it: only the columns
 * their READ grant allows (a filter builder never offers a column the
 * Data API would refuse), relations only on those, no CHECK expressions
 * (they can name any column). Administrators get the whole detail.
 */
export async function sourceDetail(context: AppContext, resourceId: string): Promise<RelationDetail> {
  const resource = await context.resourcesAdmin.get(resourceId);
  return getRelationDetail(context.database, resource.postgresOid);
}

export async function readableCatalog(context: AppContext, roleIds: string[] | null, resourceId: string, detail?: RelationDetail): Promise<RelationDetail> {
  detail ??= await sourceDetail(context, resourceId);
  if (roleIds === null) return detail;
  const permission = await context.effectivePermissions.resolve(roleIds, resourceId, "READ");
  if (permission.action !== "ALLOW") throw new TotalBaseError("RESOURCE_NOT_FOUND", "Resource not found.");
  const readable = (column: string) => permission.fieldDecision(column) === "ALLOW";
  return {
    ...detail,
    columns: detail.columns.filter((column) => readable(column.name)),
    relations: detail.relations.filter((relation) => readable(relation.sourceColumn)),
    uniqueConstraints: detail.uniqueConstraints.filter((set) => set.every(readable)),
    uniqueConstraintNames: detail.uniqueConstraintNames.filter((_name, index) => detail.uniqueConstraints[index]!.every(readable)),
    checkConstraints: [],
  };
}

/**
 * A page's record table as this viewer may use it (DataViews.md §8.5):
 * the columns they may read, and those of them they may write
 * when creating and when updating - what a form field bound to a column
 * shows as read-only. The Data API still decides every write.
 *
 * `patterns` and `bounds`: the regular expressions and the ranges (`price
 * >= 0`, `length(code) <= 10`) the columns' own CHECKs hold, as a form
 * anticipates them (@totalbase/tb-catalog's checkConstraintPatterns and
 * checkConstraintBounds) - only for the columns the viewer may write, and
 * only the pattern or the bound, never the CHECK expression itself.
 *
 * `roleIds === null` is an administrator (the App's, or the Design form's
 * Preview through `/admin/api/catalog/table/:id/record`): the whole
 * catalog, every column writable - the one computation for both, so the
 * Preview never recomputes it in the browser.
 */
export async function recordCatalog(context: AppContext, roleIds: string[] | null, resourceId: string) {
  const detail = await sourceDetail(context, resourceId);
  const catalog = await readableCatalog(context, roleIds, resourceId, detail);
  const names = catalog.columns.map((column) => column.name);
  // The values of its readable columns' CHECK lists (`condicion_iva IN (...)`) - a select's options, with their
  // labels from the presentation (B52); never the expressions, which a non-administrator's catalog leaves out.
  const expressions = detail.checkConstraints.map((check) => check.expression);
  const values = Object.fromEntries(names.map((name) => [name, checkConstraintValues(name, expressions)] as const).filter(([, found]) => found !== null));
  const withPatterns = (writable: { create: string[]; update: string[] }) => {
    const patterns: Record<string, ColumnPattern[]> = {};
    const bounds: Record<string, ColumnBound[]> = {};
    const dateBounds: Record<string, DateBound[]> = {};
    for (const column of new Set([...writable.create, ...writable.update])) {
      const found = checkConstraintPatterns(column, detail.checkConstraints);
      if (found.length) patterns[column] = found;
      const range = checkConstraintBounds(column, detail.checkConstraints);
      if (range.length) bounds[column] = range;
      const days = checkConstraintDateBounds(column, detail.checkConstraints);
      if (days.length) dateBounds[column] = days;
    }
    return { catalog, writable, patterns, bounds, dateBounds, values };
  };
  if (roleIds === null) return withPatterns({ create: names, update: names });
  const writable = async (action: "CREATE" | "UPDATE") => {
    const permission = await context.effectivePermissions.resolve(roleIds, resourceId, action);
    return permission.action === "ALLOW" ? names.filter((name) => permission.fieldDecision(name) === "ALLOW") : [];
  };
  return withPatterns({ create: await writable("CREATE"), update: await writable("UPDATE") });
}

