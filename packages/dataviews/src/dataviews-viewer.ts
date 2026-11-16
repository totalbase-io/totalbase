import type { EffectivePermissionService } from "@totalbase/permissions";
import { getPasswordColumns } from "@totalbase/resources";
import { TotalBaseError } from "@totalbase/errors";
import { grantedToRoles, reachableByRoles } from "./dataviews-access.js";
import { listPublishedFields } from "./dataviews-fields.js";
import type { AdminDataView, AdminDataViewField, DataViewsContext } from "./dataviews-types.js";

// --- What a viewer may do with a published DataView in the App (Security.md §8.1): its object access (level 2,
// dataviews-access.ts) and READ on its source (level 1), the row actions the Permission Resolver allows, the fields
// and related paths their grants let them read. `roleIds` are the caller's; null is an Administrator, who sees all.

/** Create, edit and delete on the source's rows. */
export interface RowActions {
  create: boolean;
  update: boolean;
  delete: boolean;
}

/** READ on each source resource (level 1) - a DataView with no source (EXTERNALFRAME) needs none. */
async function withSourceRead(permissions: EffectivePermissionService, roleIds: string[], views: AdminDataView[]): Promise<AdminDataView[]> {
  const resourceIds = [...new Set(views.map((view) => view.sourceResource).filter((id): id is string => id !== null))];
  const decisions = await permissions.resolveBulk(roleIds, resourceIds);
  return views.filter((view) => view.sourceResource === null || decisions.get(view.sourceResource)?.READ.decision === "ALLOW");
}

/** The App lists a DataView when the caller holds its object access, granted directly, and READ on its source. */
export async function listableDataViews(ctx: DataViewsContext, permissions: EffectivePermissionService, roleIds: string[] | null, views: AdminDataView[]): Promise<AdminDataView[]> {
  if (roleIds === null) return views;
  const granted = await grantedToRoles(ctx, views.map((view) => view.id), roleIds);
  return withSourceRead(permissions, roleIds, views.filter((view) => granted.has(view.id)));
}

/**
 * Opening one DataView: reachable (granted, or embedded in one the caller can open) and READ on its source.
 * "Denied = missing", so a caller can't probe which DataViews exist.
 */
export async function assertReadableDataView(ctx: DataViewsContext, permissions: EffectivePermissionService, roleIds: string[] | null, view: AdminDataView): Promise<void> {
  if (roleIds === null) return;
  const reachable = await reachableByRoles(ctx, view.id, roleIds);
  if (!reachable || (await withSourceRead(permissions, roleIds, [view])).length === 0) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "DataView not found.");
  }
}

/**
 * What this viewer may do to its source's rows - the Permission Resolver's CREATE/UPDATE/DELETE decisions, so the
 * App offers New, editing and Delete only where the Data API will take them (it still decides every write). An
 * Administrator may do everything; a DataView with no source, nothing.
 */
export async function grantedRowActions(permissions: EffectivePermissionService, roleIds: string[] | null, view: AdminDataView): Promise<RowActions> {
  if (view.sourceResource === null) return { create: false, update: false, delete: false };
  if (roleIds === null) return { create: true, update: true, delete: true };
  const decisions = (await permissions.resolveBulk(roleIds, [view.sourceResource])).get(view.sourceResource);
  return {
    create: decisions?.CREATE.decision === "ALLOW",
    update: decisions?.UPDATE.decision === "ALLOW",
    delete: decisions?.DELETE.decision === "ALLOW",
  };
}

/**
 * What the viewer is offered on the DataView's own pages - its list and its record form: what they're granted,
 * narrowed by the DataView's own Allow (`view_config.allow`, DataViews.md §5.1 - a history with no New). An embed
 * of it (TDataView) is narrowed by its own Allow instead, over the granted ones.
 */
export function viewerRowActions(view: AdminDataView, granted: RowActions): RowActions {
  const allow = Array.isArray(view.viewConfig.allow) ? (view.viewConfig.allow as string[]) : null;
  const allows = (action: string) => allow === null || allow.includes(action);
  return { create: granted.create && allows("create"), update: granted.update && allows("update"), delete: granted.delete && allows("delete") };
}

/**
 * A published DataView's fields as this viewer may see them: COLUMN and RELATED fields only for columns (paths)
 * their READ grant allows; an FK whose display join they may not traverse (no dotted `fk.display` field grant on
 * the source) is marked `display_field_denied`, so the grid shows the raw key instead of asking for a join the Data
 * API would refuse outright. `display_field` itself stays - it is what makes the column an FK.
 */
export async function fieldsVisibleTo(ctx: DataViewsContext, permissions: EffectivePermissionService, roleIds: string[] | null, view: AdminDataView, all: AdminDataViewField[]): Promise<AdminDataViewField[]> {
  if (view.sourceResource === null) return all;
  // A Password column is never read, not even by an administrator (Security.md §2.3): one a DataView still lists is left out.
  // So is one whose column is gone (DataViews.md §4.8) - the Data API would refuse every row; the author sees it as broken.
  const passwordColumns = await getPasswordColumns(ctx.database, view.sourceResource);
  const fields = all.filter((field) => !field.orphaned && (field.kind !== "COLUMN" || field.columnName === null || !passwordColumns.has(field.columnName)));
  if (roleIds === null) return fields;
  const permission = await permissions.resolve(roleIds, view.sourceResource, "READ");
  // A related column (RELATED, `brand.country`) the same way: its dotted path needs its own field grant on the source.
  const readableFields = fields.filter((field) => (field.kind !== "COLUMN" && field.kind !== "RELATED") || field.columnName === null || permission.fieldDecision(field.columnName) === "ALLOW");

  // The join is authorized the way the Data API authorizes it: a dotted field grant on the source (`status.name`).
  return readableFields.map((field) => {
    const config = field.config as { display_field?: string; display_template?: string };
    if (field.kind !== "COLUMN" || !field.columnName || !config.display_field) return field;
    // A display template (`{{name}} ({{country}})`) joins each of its columns - every one needs its grant.
    const template = [...(config.display_template ?? "").matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);
    const shown = template.length ? template : [config.display_field];
    if (shown.every((column) => permission.fieldDecision(`${field.columnName}.${column}`) === "ALLOW")) return field;
    return { ...field, config: { ...config, display_field_denied: true } };
  });
}

/** `{{fk.related}}` in a formula - the same one-hop token the admin's formula engine reads (formula-engine.ts TEMPLATE_TOKEN). */
const RELATION_TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * The `fk.related` paths a published DataView's formulas read (its layouts' title, description, color... in
 * `view_config`, its columns' bindings) that this viewer may not: the grid leaves them out of its `fields` - the
 * Data API would refuse the whole request - and the formula reads them as empty, the way a denied FK display shows
 * its key.
 */
export async function deniedRelationPaths(ctx: DataViewsContext, permissions: EffectivePermissionService, roleIds: string[] | null, view: AdminDataView): Promise<string[]> {
  if (roleIds === null || view.sourceResource === null) return [];
  const fields = await listPublishedFields(ctx, view.id);
  const text = JSON.stringify([view.viewConfig, fields.map((f) => f.config)]);
  const paths = new Set([...text.matchAll(RELATION_TOKEN)].map((m) => `${m[1]}.${m[2]}`));
  if (paths.size === 0) return [];
  const permission = await permissions.resolve(roleIds, view.sourceResource, "READ");
  return [...paths].filter((path) => permission.fieldDecision(path) !== "ALLOW");
}
