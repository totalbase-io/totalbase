import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AdminDashboard, AdminDashboardWidgetContent, DashboardVariable } from "@totalbase/dashboards";
import { TotalBaseError } from "@totalbase/errors";
import { isUuid } from "@totalbase/shared";
import type { AppContext } from "../context.js";
import { callerRoles } from "../caller-roles.js";
import { requestViewer } from "../display-preferences.js";
import { requireAppAccess } from "../auth-guards.js";
import { appFileScope, dashboardQueryLimits, freshRun, variableValues, type VariableValues } from "./admin-dashboards.js";
import { serveDashboardFile, verifyDashboardFile, withFileLinks } from "../dashboard-files.js";
import { optionalData, type DataBody } from "../request-body.js";

/** What a widget's download says it was (D8) - never the data. */
export interface ExportAuditBody {
  format?: unknown;
  rowCount?: unknown;
}

const EXPORT_FORMATS = ["csv", "xlsx", "png"];

/** One EXPORT audit entry for a widget's download - from the App, or from an embed (`embedId`). */
export async function recordWidgetExport(
  context: AppContext,
  request: FastifyRequest,
  principal: { type: "USER" | "ADMIN" | "SYSTEM"; id: string | null },
  dashboardId: string,
  widgetId: string,
  body: DataBody<ExportAuditBody> | undefined,
  embedId: string | null,
): Promise<string | null> {
  const { format, rowCount } = optionalData(body);
  if (typeof format !== "string" || !EXPORT_FORMATS.includes(format)) throw new TotalBaseError("INVALID_QUERY", `format must be one of ${EXPORT_FORMATS.join(", ")}.`);
  if (rowCount !== undefined && (typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0)) throw new TotalBaseError("INVALID_QUERY", "rowCount must be a whole number.");
  const now = new Date();
  return context.audit.record(context.database, {
    requestId: request.id,
    principal,
    action: "EXPORT",
    status: "EXECUTED",
    source: embedId ? "embed" : "app",
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { dashboard: dashboardId, widget: widgetId, rowCount, format, ...(embedId && { embed: embedId }) },
    startedAt: now,
    finishedAt: now,
  });
}

/** `null` = Administrator (sees every published dashboard); otherwise the caller's role ids. */
async function callerRoleScope(context: AppContext, request: FastifyRequest): Promise<string[] | null> {
  const roleIds = (await callerRoles(context, request)).roleIds;
  return (await context.roles.isAdministrator(roleIds)) ? null : roleIds;
}

/**
 * Resolves a published dashboard the caller may view, or throws
 * RESOURCE_NOT_FOUND - "denied = missing", same convention as
 * app-dataviews.ts, so a caller can't probe which slugs exist.
 */
async function viewableDashboard(context: AppContext, request: FastifyRequest, slug: string): Promise<AdminDashboard> {
  const notFound = new TotalBaseError("RESOURCE_NOT_FOUND", "Dashboard not found.");
  let dashboard: AdminDashboard;
  try {
    // Its slug, or its id - a DataView page embeds a Dashboard by id (its foreign key); a slug is never UUID-shaped.
    dashboard = isUuid(slug) ? await context.dashboardsAdmin.get(slug) : await context.dashboardsAdmin.getBySlug(slug);
  } catch {
    throw notFound;
  }
  const scope = await callerRoleScope(context, request);
  if ((await context.dashboardsAdmin.listVersions(dashboard.id)).length === 0) throw notFound;
  if (scope !== null && !(await context.dashboardsAdmin.isVisibleToRoles(dashboard.id, scope))) throw notFound;
  return dashboard;
}

/** A viewer gets the layout and presentation, never the SQL itself - only whether there is one (`configured`). */
export function withoutQuery(widget: AdminDashboardWidgetContent): Omit<AdminDashboardWidgetContent, "query"> & { configured: boolean } {
  const { query, ...rest } = widget;
  return { ...rest, configured: query !== null };
}

/** Identity only - `variables` on AdminDashboard is the *draft* (incl. options-query SQL); Apps serves the published ones separately. */
function publicDashboard(dashboard: AdminDashboard): Omit<AdminDashboard, "variables" | "tabs"> {
  const { variables: _draft, tabs: _draftTabs, ...rest } = dashboard;
  return rest;
}

/** A viewer sees a SELECT variable's options (via the options route), never the options query's SQL. */
export function withoutOptionsQuery(variable: DashboardVariable): DashboardVariable {
  if (variable.options?.source !== "QUERY") return variable;
  return { ...variable, options: { source: "QUERY", query: "" } };
}

/**
 * Published dashboards for the /app UI. Access is per dashboard x role
 * (Specification_Dashboards.md §2.6); widget data
 * is executed by widget id from the published snapshot - the caller
 * never sends SQL (AGENTS.md section 7 "Dashboard widget SQL").
 */
export function registerAppDashboardsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  // A file a widget's query returned (D14): its signed link is the credential - an <img> sends no header. The
  // signature names this dashboard, widget and file and expires; nothing else is opened, and the query isn't run.
  app.get<{ Params: { slug: string; widgetId: string; fileId: string }; Querystring: Record<string, string | undefined> }>(
    "/app/api/dashboards/:slug/widgets/:widgetId/files/:fileId",
    async (request, reply) => {
      const claims = verifyDashboardFile(context.dashboardFilesKey, request.query.token, { widget: request.params.widgetId, file: request.params.fileId, embed: null });
      if (claims.d !== request.params.slug) throw new TotalBaseError("DASHBOARD_FILE_TOKEN_INVALID", "This file's link isn't valid or has expired - reload the dashboard for a new one.");
      return serveDashboardFile(context, reply, request.params.fileId, request.query, () => true);
    },
  );

  app.get("/app/api/dashboards", { preHandler }, async (request) => ({
    data: (await context.dashboardsAdmin.listPublished(await callerRoleScope(context, request))).map(publicDashboard),
  }));

  app.get<{ Params: { slug: string } }>("/app/api/dashboards/:slug", { preHandler }, async (request) => {
    const dashboard = await viewableDashboard(context, request, request.params.slug);
    // Its published tabs (D7), not the draft's.
    return { data: { ...publicDashboard(dashboard), tabs: await context.dashboardsAdmin.getPublishedTabs(dashboard.id) } };
  });

  app.get<{ Params: { slug: string } }>("/app/api/dashboards/:slug/widgets", { preHandler }, async (request) => {
    const dashboard = await viewableDashboard(context, request, request.params.slug);
    return { data: (await context.dashboardsAdmin.getPublishedWidgets(dashboard.id)).map(withoutQuery) };
  });

  app.get<{ Params: { slug: string } }>("/app/api/dashboards/:slug/variables", { preHandler }, async (request) => {
    const dashboard = await viewableDashboard(context, request, request.params.slug);
    const viewer = await requestViewer(context, request);
    const variables = await context.dashboardsAdmin.withDefaultValues(await context.dashboardsAdmin.getPublishedVariables(dashboard.id), viewer.userId);
    return { data: variables.map(withoutOptionsQuery) };
  });

  app.post<{ Params: { slug: string; name: string }; Body: DataBody<VariableValues> }>(
    "/app/api/dashboards/:slug/variables/:name/options",
    { preHandler },
    async (request) => {
      const dashboard = await viewableDashboard(context, request, request.params.slug);
      return {
        data: await context.dashboardsAdmin.variableOptions(
          dashboard.id,
          request.params.name,
          "PUBLISHED",
          await dashboardQueryLimits(context),
          await requestViewer(context, request),
          variableValues(request.body),
        ),
      };
    },
  );

  // A widget's download (D8): one EXPORT entry - the dashboard, the widget, its rows and format - never the data.
  app.post<{ Params: { slug: string; widgetId: string }; Body: DataBody<ExportAuditBody> }>(
    "/app/api/dashboards/:slug/widgets/:widgetId/exports",
    { preHandler },
    async (request, reply) => {
      const dashboard = await viewableDashboard(context, request, request.params.slug);
      const widget = (await context.dashboardsAdmin.getPublishedWidgets(dashboard.id)).find((w) => w.id === request.params.widgetId);
      if (!widget) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_FOUND", `Widget not found: ${request.params.widgetId}`);
      const roleIds = await callerRoleScope(context, request);
      const id = await recordWidgetExport(context, request, { type: roleIds === null ? "ADMIN" : "USER", id: request.admin!.id }, dashboard.id, widget.id, request.body, null);
      reply.code(201);
      return { data: { id } };
    },
  );

  // `$USER.*` = the viewer; `$VAR.*` values come from the body, bound against the published definitions.
  app.post<{ Params: { slug: string; widgetId: string }; Body: DataBody<VariableValues> & { fresh?: boolean } }>(
    "/app/api/dashboards/:slug/widgets/:widgetId/data",
    { preHandler },
    async (request) => {
      const dashboard = await viewableDashboard(context, request, request.params.slug);
      return {
        data: await withFileLinks(context, await context.dashboardsAdmin.executePublishedWidget(
          dashboard.id,
          request.params.widgetId,
          { ...(await dashboardQueryLimits(context)), ...freshRun(request.body) },
          await requestViewer(context, request),
          variableValues(request.body),
        ), appFileScope(dashboard.id, request.params.widgetId)),
      };
    },
  );
}
