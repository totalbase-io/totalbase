import { UUID_PATTERN } from "@totalbase/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { callerRoleIds, callerRoles } from "../caller-roles.js";
import { settingsWritable, viewerRowActions, type AdminDataView, type AdminDataViewField, type RowActions } from "@totalbase/dataviews";
import { ReadAudit, readOrigin } from "../read-audit.js";
import { TotalBaseError } from "@totalbase/errors";
import { getPasswordColumns } from "@totalbase/resources";
import type { CustomAction } from "@totalbase/tb-catalog";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";


/** The App's DataView list for these roles (Security.md §8.1) - `@totalbase/dataviews` decides, with the Permission Resolver. */
export function listableDataViews(context: AppContext, roleIds: string[] | null, views: AdminDataView[]): Promise<AdminDataView[]> {
  return context.dataviewsAdmin.listableTo(context.effectivePermissions, roleIds, views);
}

/** Both row-action sets, for the App's read of a DataView: the granted ones and the DataView's own Allow over them. */
async function rowActions(context: AppContext, request: FastifyRequest, view: AdminDataView): Promise<{ viewerActions: RowActions; grantedActions: RowActions }> {
  const granted = await context.dataviewsAdmin.grantedRowActions(context.effectivePermissions, await callerRoleIds(context, request), view);
  return { viewerActions: viewerRowActions(view, granted), grantedActions: granted };
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
      const fn = await context.resourcesAdmin.get(action.target.resource).catch(() => null);
      if (!fn || fn.type !== "FUNCTION" || fn.status !== "ACTIVE" || !fn.exposedMethods.includes("POST")) continue;
      if ((await context.effectivePermissions.resolve(roleIds, action.target.resource, "EXECUTE")).action !== "ALLOW") continue;
      targets[action.id] = { kind: "FUNCTION", schema: fn.schema, name: fn.name };
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
  await context.dataviewsAdmin.assertReadableBy(context.effectivePermissions, await callerRoleIds(context, request), view);
  return view;
}

/** Its fields as this viewer may read them (`@totalbase/dataviews`' fieldsVisibleTo). */
async function fieldsVisibleTo(context: AppContext, request: FastifyRequest, view: AdminDataView, all: AdminDataViewField[]): Promise<AdminDataViewField[]> {
  return context.dataviewsAdmin.fieldsVisibleTo(context.effectivePermissions, await callerRoleIds(context, request), view, all);
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
        deniedRelationPaths: await context.dataviewsAdmin.deniedRelationPaths(context.effectivePermissions, await callerRoleIds(context, request), view),
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
    // A read of the table's keys under the viewer's grants: its READ audit row, like any Data API read's (audit_read).
    const { writable } = await settingsWritable(context, principal, view, (client, read) =>
      new ReadAudit(context, readOrigin(request), read.resource, principal).executed(client, { fields: [{ path: [read.keyColumn] }] }, read.rowCount));
    return { data: writable };
  });

  app.get<{ Params: { slug: string }; Querystring: { draft?: string } }>("/app/api/dataviews/:slug/fields", { preHandler }, async (request) => {
    if (request.query.draft === "true") {
      const view = await draftDataView(request, request.params.slug);
      return { data: await fieldsVisibleTo(context, request, view, await context.dataviewsAdmin.listFields(view.id)) };
    }
    const view = await openableDataView(context, request, request.params.slug);
    return { data: await fieldsVisibleTo(context, request, view, await context.dataviewsAdmin.listPublishedFields(view.id)) };
  });
}
