import { UUID_PATTERN } from "@totalbase/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { callerRoleIds, callerRoles } from "../caller-roles.js";
import { settingsWritable, type AdminDataView, type AdminDataViewField } from "@totalbase/dataviews";
import { ReadAudit } from "../read-audit.js";
import { TotalBaseError } from "@totalbase/errors";
import type { CustomAction } from "@totalbase/tb-catalog";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";


/** READ on each source resource (level 1) - a DataView with no source (EXTERNALFRAME) needs none. */
async function withSourceRead(context: AppContext, roleIds: string[], views: AdminDataView[]): Promise<AdminDataView[]> {
  const resourceIds = [...new Set(views.map((view) => view.sourceResource).filter((id): id is string => id !== null))];
  const decisions = await context.effectivePermissions.resolveBulk(roleIds, resourceIds);
  return views.filter((view) => view.sourceResource === null || decisions.get(view.sourceResource)?.READ.decision === "ALLOW");
}

/**
 * The App lists a DataView when the caller holds its object access
 * (level 2, granted directly) and READ on its source (level 1) -
 * Security.md §8.1.
 */
export async function listableDataViews(context: AppContext, roleIds: string[] | null, views: AdminDataView[]): Promise<AdminDataView[]> {
  if (roleIds === null) return views;
  const granted = await context.dataviewsAdmin.grantedToRoles(views.map((view) => view.id), roleIds);
  return withSourceRead(context, roleIds, views.filter((view) => granted.has(view.id)));
}

/**
 * Opening one DataView: reachable (granted, or embedded in one the caller
 * can open) and READ on its source. "Denied = missing", so a caller can't
 * probe which DataViews exist.
 */
async function assertReadableDataView(context: AppContext, request: FastifyRequest, view: AdminDataView): Promise<void> {
  const roleIds = await callerRoleIds(context, request);
  if (roleIds === null) return;
  const reachable = await context.dataviewsAdmin.reachableByRoles(view.id, roleIds);
  if (!reachable || (await withSourceRead(context, roleIds, [view])).length === 0) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "DataView not found.");
  }
}

type RowActions = { create: boolean; update: boolean; delete: boolean };

/**
 * What this viewer may do to its source's rows - the Permission Resolver's
 * CREATE/UPDATE/DELETE decisions, so the App offers New, editing and
 * Delete only where the Data API will take them (it still decides every
 * write). An Administrator may do everything; a DataView with no source, nothing.
 */
async function grantedActions(context: AppContext, request: FastifyRequest, view: AdminDataView): Promise<RowActions> {
  if (view.sourceResource === null) return { create: false, update: false, delete: false };
  const roleIds = await callerRoleIds(context, request);
  if (roleIds === null) return { create: true, update: true, delete: true };
  const decisions = (await context.effectivePermissions.resolveBulk(roleIds, [view.sourceResource])).get(view.sourceResource);
  return {
    create: decisions?.CREATE.decision === "ALLOW",
    update: decisions?.UPDATE.decision === "ALLOW",
    delete: decisions?.DELETE.decision === "ALLOW",
  };
}

/**
 * What the viewer is offered on the DataView's own pages - its list and its record form: what they're granted,
 * narrowed by the DataView's own Allow (`view_config.allow`, DataViews.md §5.1 - a history with no
 * New), an Administrator's too. An embed of it (TDataView) is narrowed by its own Allow instead, over
 * `grantedActions` - the same DataView may be a listing with no New and, in a record's page, where rows are made.
 */
function viewerActions(view: AdminDataView, granted: RowActions): RowActions {
  const allow = Array.isArray(view.viewConfig.allow) ? (view.viewConfig.allow as string[]) : null;
  const allows = (action: string) => allow === null || allow.includes(action);
  return { create: granted.create && allows("create"), update: granted.update && allows("update"), delete: granted.delete && allows("delete") };
}

/** Both, for the App's read of a DataView. */
async function rowActions(context: AppContext, request: FastifyRequest, view: AdminDataView): Promise<{ viewerActions: RowActions; grantedActions: RowActions }> {
  const granted = await grantedActions(context, request, view);
  return { viewerActions: viewerActions(view, granted), grantedActions: granted };
}

/** What a custom action runs, as the App calls it - only for one this viewer may run. */
type ActionTarget = { kind: "FUNCTION"; schema: string; name: string } | { kind: "WORKFLOW"; slug: string };

/**
 * The DataView's custom actions this viewer may run (DataViews.md §3.7), by action id: a function
 * exposed for calls they may EXECUTE, a published, enabled MANUAL workflow they may INVOKE - the rest never show.
 */
async function actionTargets(context: AppContext, request: FastifyRequest, view: AdminDataView): Promise<{ actionTargets: Record<string, ActionTarget> }> {
  const actions = Array.isArray(view.viewConfig.custom_actions) ? (view.viewConfig.custom_actions as CustomAction[]) : [];
  const targets: Record<string, ActionTarget> = {};
  if (actions.length === 0) return { actionTargets: targets };
  const roleIds = (await callerRoles(context, request)).roleIds;
  for (const action of actions) {
    if (action.target.kind === "FUNCTION") {
      const { rows } = await context.database.query<{ schema: string; name: string }>(
        `SELECT "schema", name FROM totalbase.resources WHERE id = $1 AND type = 'FUNCTION' AND status = 'ACTIVE' AND 'POST' = ANY(exposed_methods)`,
        [action.target.resource],
      );
      if (!rows[0]) continue;
      if ((await context.effectivePermissions.resolve(roleIds, action.target.resource, "EXECUTE")).action !== "ALLOW") continue;
      targets[action.id] = { kind: "FUNCTION", schema: rows[0].schema, name: rows[0].name };
    } else {
      const workflow = await context.workflowsAdmin.get(action.target.workflow).catch(() => null);
      const found = workflow ? await context.workflowsAdmin.getEnabledPublishedBySlug(workflow.slug) : null;
      const start = ((found?.definition.operations as { type: string; configuration: Record<string, unknown> }[] | undefined) ?? []).find((op) => op.type === "totalbase.start");
      if (!found || start?.configuration.trigger !== "MANUAL") continue;
      if ((await context.workflowPermissions.resolveInvoke(roleIds, found.workflow.id)) !== "ALLOW") continue;
      targets[action.id] = { kind: "WORKFLOW", slug: found.workflow.slug };
    }
  }
  return { actionTargets: targets };
}

/** A published DataView, or the same RESOURCE_NOT_FOUND a denied one gets - a missing slug must not read differently. */
async function publishedOrNotFound(lookup: () => Promise<AdminDataView>): Promise<AdminDataView> {
  try {
    return await lookup();
  } catch {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "DataView not found.");
  }
}


/**
 * The published DataView `slug` names - its slug, or its id (an embedded
 * DataView is stored by id; a slug is never UUID-shaped) - if the caller may
 * open it, else RESOURCE_NOT_FOUND. Shared by every App per-DataView route.
 */
export async function openableDataView(context: AppContext, request: FastifyRequest, slug: string): Promise<AdminDataView> {
  const view = await publishedOrNotFound(async () => {
    try {
      return await (UUID_PATTERN.test(slug) ? context.dataviewsAdmin.getPublished(slug) : context.dataviewsAdmin.getPublishedBySlug(slug));
    } catch (error) {
      // Never published: an administrator still reaches its runtime routes (prefs, saved views,
      // catalog...) - the device preview frames its draft (DataViews.md §12.9).
      if ((await callerRoleIds(context, request)) !== null) throw error;
      return UUID_PATTERN.test(slug) ? context.dataviewsAdmin.get(slug) : context.dataviewsAdmin.getBySlug(slug);
    }
  });
  await assertReadableDataView(context, request, view);
  return view;
}

/**
 * A published DataView's fields as this viewer may see them: COLUMN and
 * RELATED fields only for columns (paths) their READ grant allows; an FK whose display join they
 * may not traverse (no dotted `fk.display` field grant on the source) is marked
 * `display_field_denied`, so the grid shows the raw key instead of asking
 * for a join the Data API would refuse outright (FIELD_PERMISSION_DENIED
 * on `fk.display`). `display_field` itself stays - it is what makes the
 * column an FK (a Kanban's group column, for one).
 */
async function fieldsForViewer(context: AppContext, request: FastifyRequest, view: AdminDataView): Promise<AdminDataViewField[]> {
  const fields = await context.dataviewsAdmin.listPublishedFields(view.id);
  return fieldsVisibleTo(context, request, view, fields);
}

async function fieldsVisibleTo(context: AppContext, request: FastifyRequest, view: AdminDataView, fields: AdminDataViewField[]): Promise<AdminDataViewField[]> {
  const roleIds = await callerRoleIds(context, request);
  if (roleIds === null || view.sourceResource === null) return fields;
  const permission = await context.effectivePermissions.resolve(roleIds, view.sourceResource, "READ");
  // A related column (RELATED, `brand.country`) the same way: its dotted path needs its own field grant on the source - without it, it's left out.
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
 * The `fk.related` paths a published DataView's formulas read (its layouts'
 * title, description, color... in `view_config`, its columns' bindings) that
 * this viewer may not: the grid leaves them out of its `fields` - the Data
 * API would refuse the whole request (FIELD_PERMISSION_DENIED) - and the
 * formula reads them as empty, the way a denied FK display shows its key.
 */
async function deniedRelationPaths(context: AppContext, request: FastifyRequest, view: AdminDataView): Promise<string[]> {
  const roleIds = await callerRoleIds(context, request);
  if (roleIds === null || view.sourceResource === null) return [];
  const fields = await context.dataviewsAdmin.listPublishedFields(view.id);
  const text = JSON.stringify([view.viewConfig, fields.map((f) => f.config)]);
  const paths = new Set([...text.matchAll(RELATION_TOKEN)].map((m) => `${m[1]}.${m[2]}`));
  if (paths.size === 0) return [];
  const permission = await context.effectivePermissions.resolve(roleIds, view.sourceResource, "READ");
  return [...paths].filter((path) => permission.fieldDecision(path) !== "ALLOW");
}

/** Published DataView snapshots for the /app UI. Draft/design endpoints stay in /admin/api. */
export function registerAppDataViewsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  app.get("/app/api/dataviews", { preHandler }, async (request) => ({
    data: await listableDataViews(context, await callerRoleIds(context, request), await context.dataviewsAdmin.listPublished()),
  }));

  /**
   * `?draft=true` (DataViews.md §12.9): the draft instead of the
   * published version, inside the App shell - the editor's device preview.
   * Administrators only: anyone else gets RESOURCE_NOT_FOUND, as for a
   * DataView they can't open.
   */
  async function draftDataView(request: FastifyRequest, slug: string): Promise<AdminDataView> {
    if ((await callerRoleIds(context, request)) !== null) throw new TotalBaseError("RESOURCE_NOT_FOUND", `DataView not found: ${slug}`);
    return UUID_PATTERN.test(slug) ? context.dataviewsAdmin.get(slug) : context.dataviewsAdmin.getBySlug(slug);
  }

  /**
   * The instance's toolbar default (dataviews.toolbar_mode, DataViews.md §5) - what a list
   * DataView opens with when neither the viewer nor its default_state chose; null for `auto` (the type's own).
   * Sent with the DataView: an App user can't read the settings.
   */
  /** The most rows a viewer may choose and edit together (DataViews.md §5.15) - sent with the DataView, as an App user can't read settings. */
  async function bulkEditMaxRows(): Promise<number> {
    return context.settings.get("dataviews.bulk_edit_max_rows");
  }
  async function instanceToolbarMode(): Promise<"full" | "compact" | null> {
    const mode = await context.settings.get("dataviews.toolbar_mode");
    return mode === "auto" ? null : mode;
  }

  /**
   * The instance's page width defaults (DataViews.md §6.7) - what a DataView with no
   * page_content_width / page_content_align of its own takes. Sent with it: an App user can't read settings.
   */
  async function instancePageLayout() {
    return {
      recordWidth: await context.settings.get("dataviews.record_content_width"),
      customWidth: await context.settings.get("dataviews.custom_content_width"),
      align: await context.settings.get("dataviews.content_align"),
      tableMargin: await context.settings.get("dataviews.table_margin"),
    };
  }

  // `:slug` is the DataView's slug or its id, here and in every /app/api/dataviews/:slug/... route.
  app.get<{ Params: { slug: string }; Querystring: { draft?: string } }>("/app/api/dataviews/:slug", { preHandler }, async (request) => {
    if (request.query.draft === "true") {
      const view = await draftDataView(request, request.params.slug);
      return { data: { ...view, deniedRelationPaths: [], ...(await rowActions(context, request, view)), ...(await actionTargets(context, request, view)), instanceToolbarMode: await instanceToolbarMode(), instancePageLayout: await instancePageLayout(), bulkEditMaxRows: await bulkEditMaxRows() } };
    }
    const view = await openableDataView(context, request, request.params.slug);
    return {
      data: {
        ...view,
        deniedRelationPaths: await deniedRelationPaths(context, request, view),
        ...(await rowActions(context, request, view)),
        ...(await actionTargets(context, request, view)),
        instanceToolbarMode: await instanceToolbarMode(),
        instancePageLayout: await instancePageLayout(),
        bulkEditMaxRows: await bulkEditMaxRows(),
      },
    };
  });

  // A SETTINGS DataView's rows the viewer may change - each shows locked or editable (DataViews.md §5.12).
  app.get<{ Params: { slug: string } }>("/app/api/dataviews/:slug/settings-writable", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    if (view.viewType !== "SETTINGS") throw new TotalBaseError("INVALID_QUERY", "Only a SETTINGS DataView has settings rows.");
    const principal = await resolveDataPrincipal(context, extractBearerToken(request), request.headers["x-totalbase-timezone"], request);
    const { writable, read } = await settingsWritable(context, principal, view);
    // A read of the table's keys under the viewer's grants: its READ audit row, like any Data API read's (audit_read).
    if (read) await new ReadAudit(context, request, read.resource, principal).executed(context.database, { fields: [{ path: [read.keyColumn] }] }, read.rowCount);
    return { data: writable };
  });

  app.get<{ Params: { slug: string }; Querystring: { draft?: string } }>("/app/api/dataviews/:slug/fields", { preHandler }, async (request) => {
    if (request.query.draft === "true") {
      const view = await draftDataView(request, request.params.slug);
      return { data: await fieldsVisibleTo(context, request, view, await context.dataviewsAdmin.listFields(view.id)) };
    }
    const view = await openableDataView(context, request, request.params.slug);
    return { data: await fieldsForViewer(context, request, view) };
  });
}
