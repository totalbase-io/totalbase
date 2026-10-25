import type { FastifyInstance, FastifyRequest } from "fastify";
import { embedClick, type DashboardQueryLimits, type DashboardScope, type DashboardWidgetType, type TypedResultColumn } from "@totalbase/dashboards";
import { TotalBaseError } from "@totalbase/errors";
import { dashboardDecision, dashboardValueKind, decisionLanguage, type DashboardDecisionLanguage } from "@totalbase/tb-catalog";
import { dataEnvelope } from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { withFileLinks } from "../dashboard-files.js";
import { requestViewer } from "../display-preferences.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, created, NO_CONTENT, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";
import {
  DASHBOARD_COLOR,
  DASHBOARD_REFRESH_INTERVAL,
  DASHBOARD_SCHEMAS,
  DASHBOARD_SCOPE,
  DASHBOARD_TABS,
  DASHBOARD_VARIABLE_VALUES,
  DASHBOARD_WIDGET_TYPE,
  WIDGET_SQL_SEMANTICS,
} from "../openapi-admin-docs-dashboards.js";
import { type DataBody, optionalData, publishNote, versionParam } from "../request-body.js";
import { registerDeleteVersionsRoute } from "./delete-versions.js";

interface CreateDashboardBody {
  name: string;
  slug?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  scope?: DashboardScope;
  refreshIntervalSeconds?: number | null;
}

interface ApplySpecBody {
  spec?: unknown;
  draftVersion?: string;
  dryRun?: boolean;
  /** Each widget's first rows in the answer - 0 (the default) runs none. */
  rows?: number;
}

interface UpdateDashboardBody {
  name?: string;
  slug?: string;
  description?: string | null;
  menuLabel?: string | null;
  icon?: string | null;
  color?: string | null;
  scope?: DashboardScope;
  refreshIntervalSeconds?: number | null;
  embeddingEnabled?: boolean;
  delegable?: boolean;
  variables?: unknown;
  tabs?: unknown;
}


/** Viewer-chosen `$VAR.*` values - validated per variable type by @totalbase/dashboards, never interpolated. */
export interface VariableValues {
  variables?: Record<string, unknown>;
}

export function variableValues(body: DataBody<VariableValues> | undefined): Record<string, unknown> {
  const values = optionalData(body).variables;
  return values && typeof values === "object" && !Array.isArray(values) ? values : {};
}

/** A result's column as an author plans a widget with it (DM8): its type, the kind a role takes, lossy, its origin. */
function columnInfo(c: TypedResultColumn) {
  return {
    name: c.name,
    type: c.dataType,
    kind: dashboardValueKind(c),
    ...(c.lossy && { lossy: true }),
    ...(c.origin && { origin: `${c.origin.schema}.${c.origin.table}.${c.origin.column}` }),
  };
}

/** The App's language (`system.language`) - what an automatic decision's message is in (DM3). */
export async function appLanguage(context: AppContext): Promise<DashboardDecisionLanguage> {
  return decisionLanguage(await context.settings.get("system.language"));
}

/** A `:version` path parameter: a non-negative integer (400 otherwise); a number with no such version is the service's 404. */

interface CreateWidgetBody {
  type: DashboardWidgetType;
  label?: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  query?: string | null;
  config?: Record<string, unknown>;
  tab?: string | null;
}

interface UpdateWidgetBody {
  type?: string;
  label?: string | null;
  gridX?: number;
  gridY?: number;
  gridW?: number;
  gridH?: number;
  query?: string | null;
  config?: Record<string, unknown>;
  tab?: string | null;
}

/** Where a widget's file links point (D14): the App's route, by the dashboard's id - served by the signature alone. */
export function appFileScope(dashboardId: string, widgetId: string) {
  return { dashboardId, widgetId, route: `/app/api/dashboards/${dashboardId}/widgets/${widgetId}/files` };
}

export async function dashboardQueryLimits(context: AppContext): Promise<DashboardQueryLimits> {
  const [timeoutMs, maxRows, maxConcurrent, cacheSeconds] = await Promise.all([
    context.settings.get("dashboards.query_timeout_ms"),
    context.settings.get("dashboards.query_max_rows"),
    context.settings.get("dashboards.max_concurrent_queries"),
    context.settings.get("dashboards.cache_seconds"),
  ]);
  return { timeoutMs, maxRows, maxConcurrent, cacheSeconds };
}

/** A viewer's Refresh: `{ "data": {...}, "fresh": true }` - the run skips the cached result (D24). */
export function freshRun(body: { fresh?: unknown } | undefined | null): { fresh?: boolean } {
  return body?.fresh === true ? { fresh: true } : {};
}

/**
 * Dashboard management - admin-only (the whole surface: identity,
 * widgets, draft SQL execution, role grants, publish). Viewing a
 * published dashboard goes through app-dashboards.ts instead, which
 * never accepts SQL from the caller. See AGENTS.md section 7
 * "Dashboard widget SQL".
 */
export function registerAdminDashboardsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);
  const schemas = DASHBOARD_SCHEMAS;
  const ID = { id: { ...UUID_PARAM, description: "The dashboard's id." } };
  const WIDGET = { ...ID, widgetId: { ...UUID_PARAM, description: "The widget's id." } };
  const VERSION = { ...ID, version: { schema: { type: "integer" }, description: "The version number (1, 2, ...)." } };
  const VARIABLE_NAME = { name: { description: "The variable's name (a SELECT variable)." } };
  const VALUES_BODY = { schema: dataEnvelope(object({ variables: DASHBOARD_VARIABLE_VALUES })), required: false };
  const IDENTITY = {
    name: { type: "string", maxLength: 32 },
    slug: { type: "string", maxLength: 32, description: "URL-safe; proposed from `name` when omitted." },
    description: { type: ["string", "null"], maxLength: 128 },
    icon: { type: ["string", "null"], description: "An icon name, e.g. i-lucide-chart-pie." },
    color: DASHBOARD_COLOR,
    scope: { ...DASHBOARD_SCOPE, description: `${DASHBOARD_SCOPE.description} Default LISTED.` },
    refreshIntervalSeconds: { ...DASHBOARD_REFRESH_INTERVAL, description: `${DASHBOARD_REFRESH_INTERVAL.description} Default null.` },
  };
  const GRID = {
    gridX: { type: "integer", description: "Column on the 12-column canvas." },
    gridY: { type: "integer" },
    gridW: { type: "integer" },
    gridH: { type: "integer" },
  };

  app.get("/admin/api/dashboards", {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "List dashboards",
      description: "Every dashboard, by name, with its versioning status (live version, unpublished draft changes).",
      response: ok(arrayOf(ref("DashboardListItem"))),
      schemas,
    }),
  }, async () => ({ data: await context.dashboardsAdmin.list() }));

  app.get<{ Params: { id: string } }>(
    "/admin/api/dashboards/:id",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Get a dashboard",
      description: "Its identity, the draft's variable definitions and whether the draft differs from the latest version.",
      pathParameters: ID,
      response: ok(ref("DashboardWithStatus")),
      schemas,
    }),
  },
    async (request) => {
      const dashboard = await context.dashboardsAdmin.getWithStatus(request.params.id);
      // Each variable's default resolved for this administrator (D22) - what the editor's bar starts with.
      const viewer = await requestViewer(context, request);
      return { data: { ...dashboard, variables: await context.dashboardsAdmin.withDefaultValues(dashboard.variables, viewer.userId) } };
    },
  );

  // --- The draft as one document (Dashboards.md §8.3, DM2) ---

  /** Who sees it - its roles and embeds, read-only beside the spec: they apply at once, not on publishing. */
  const access = async (id: string) => {
    const language = await appLanguage(context);
    const [dashboard, roleIds, embeds, published] = await Promise.all([
      context.dashboardsAdmin.get(id),
      context.dashboardsAdmin.listRoles(id),
      context.dashboardEmbeds.list(id),
      context.dashboardsAdmin.getPublishedWidgets(id).catch(() => []),
    ]);
    return {
      roleIds,
      embeddingEnabled: dashboard.embeddingEnabled,
      embeds: embeds.map((e) => {
        // The published widgets whose click doesn't run in this embed (D6), each a decision with its reason (DM3).
        const editable = new Set(Object.entries(e.variables).filter(([, v]) => v.mode === "EDITABLE").map(([name]) => name));
        const notices = published
          .filter((w) => w.config.click && !embedClick(w.config, editable))
          .map((w) => dashboardDecision("click-not-in-embed", language, { widget: w.label || w.type }, w.id));
        return { id: e.id, name: e.name, type: e.type, revoked: e.revokedAt !== null, expiresAt: e.expiresAt, notices };
      }),
    };
  };

  app.get<{ Params: { id: string } }>(
    "/admin/api/dashboards/:id/spec",
    {
      preHandler,
      ...adminDoc("dashboards", {
        summary: "Get a dashboard's draft as a spec",
        description: "The whole draft as one document - its identity, variables, tabs and widgets (each with its id, grid, query and config) - plus draftVersion (what apply's draftVersion compares), the live version, whether the draft differs from it, and who sees it (roles and embeds, read-only: they apply at once). PUT it back unchanged and nothing changes.",
        pathParameters: ID,
        response: ok(ref("DashboardSpecDocument")),
        schemas,
      }),
    },
    async (request) => ({ data: { ...(await context.dashboardsAdmin.getSpec(request.params.id)), access: await access(request.params.id) } }),
  );

  /** Applies a spec - a new dashboard without `id` - recording one audit event in the same transaction. */
  const applySpec = async (request: FastifyRequest<{ Body: DataBody<ApplySpecBody> }>, id: string | null) => {
    const body = optionalData(request.body);
    const language = await appLanguage(context);
    const result = await context.dashboardsAdmin.applySpec(id, { spec: body.spec, draftVersion: body.draftVersion, dryRun: body.dryRun === true }, language, async (client, summary) => {
      await context.audit.record(client, {
        requestId: request.id,
        principal: { type: "ADMIN", id: request.admin!.id },
        action: summary.created ? "CREATE" : "UPDATE",
        status: "EXECUTED",
        source: "admin",
        metadata: {
          event: "dashboard.spec_applied",
          dashboard: summary.dashboardId,
          created: summary.created,
          dashboardKeys: summary.diff.dashboard,
          variables: summary.diff.variables,
          tabs: summary.diff.tabs,
          widgetsCreated: summary.diff.widgets.created.length,
          widgetsChanged: summary.diff.widgets.changed.map((w) => w.id),
          widgetsDeleted: summary.diff.widgets.deleted.map((w) => w.id),
        },
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    });
    // Rows only when asked: applying twelve widgets doesn't run twelve queries.
    const rows = Number.isInteger(body.rows) && (body.rows as number) > 0 ? Math.min(body.rows as number, 50) : 0;
    const widgets = await Promise.all(result.widgets.map(async (widget) => {
      const base = { ...widget, columns: widget.columns?.map(columnInfo) ?? null };
      if (!rows || !result.applied || !result.id || !widget.id) return base;
      try {
        const run = await context.dashboardsAdmin.executeDraftWidget(result.id, widget.id, await dashboardQueryLimits(context), await requestViewer(context, request), {}, language);
        return { ...base, rows: run.rows.slice(0, rows) };
      } catch (error) {
        return { ...base, error: error instanceof TotalBaseError ? { code: error.code, message: error.message } : { code: "INTERNAL_ERROR", message: "Could not run it." } };
      }
    }));
    return { ...result, widgets };
  };
  const APPLY_DOC = {
    requestBody: { schema: dataEnvelope(ref("DashboardApplySpec")) },
    errors: ["409" as const, "422" as const],
    schemas,
  };

  app.post<{ Body: DataBody<ApplySpecBody> }>(
    "/admin/api/dashboards/spec",
    {
      preHandler,
      ...adminDoc("dashboards", {
        summary: "Create a dashboard from a spec",
        description: "A new dashboard with its whole draft in one transaction - every problem at once (422 DASHBOARD_SPEC_INVALID, each error with its path), nothing created. dryRun: checks and answers what it would create. Unpublished, no roles.",
        response: created(ref("DashboardApplyResult")),
        ...APPLY_DOC,
      }),
    },
    async (request, reply) => {
      const result = await applySpec(request, null);
      if (result.applied) reply.code(201);
      return { data: result };
    },
  );

  app.put<{ Params: { id: string }; Body: DataBody<ApplySpecBody> }>(
    "/admin/api/dashboards/:id/spec",
    {
      preHandler,
      ...adminDoc("dashboards", {
        summary: "Replace a dashboard's draft with a spec",
        description: "The whole draft in one transaction: a widget with an id is that widget (kept), one without is new, one left out is deleted. Every problem at once (422 DASHBOARD_SPEC_INVALID, each with its path), nothing applied; a draftVersion older than the draft is 409 DASHBOARD_DRAFT_CHANGED. dryRun: the difference only. The published version stays until publish.",
        pathParameters: ID,
        response: ok(ref("DashboardApplyResult")),
        ...APPLY_DOC,
      }),
    },
    async (request) => ({ data: await applySpec(request, request.params.id) }),
  );

  app.post<{ Body: DataBody<CreateDashboardBody> }>("/admin/api/dashboards", {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Create a dashboard",
      description: "An empty, unpublished draft with no role grants (only administrators see it until roles are set and it is published).",
      requestBody: { schema: dataEnvelope(object(IDENTITY, ["name"])) },
      response: created(ref("Dashboard")),
      schemas,
    }),
  }, async (request, reply) => {
    const body = optionalData(request.body);
    const dashboard = await context.dashboardsAdmin.create({
      name: body.name ?? "",
      slug: body.slug,
      description: body.description,
      icon: body.icon,
      color: body.color,
      scope: body.scope,
      refreshIntervalSeconds: body.refreshIntervalSeconds,
    });
    reply.code(201);
    return { data: dashboard };
  });

  app.patch<{ Params: { id: string }; Body: DataBody<UpdateDashboardBody> }>(
    "/admin/api/dashboards/:id",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Update a dashboard",
      description:
        "Identity, `refreshIntervalSeconds` and `embeddingEnabled` changes apply at once (they are not versioned). `variables` replaces the draft's whole definition " +
        "list - versioned with the widgets, so it reaches Apps on the next publish.",
      pathParameters: ID,
      requestBody: {
        schema: dataEnvelope(object({
          ...IDENTITY,
          menuLabel: { type: ["string", "null"], maxLength: 32, description: "What the App menu shows - empty or null: its name. Applies at once, never versioned." },
          embeddingEnabled: { type: "boolean", description: "Whether a signed embed token may show its published version outside TotalBase (Dashboards.md §9.5)." },
          delegable: { type: "boolean", description: "Whether a manager may open it to the roles below theirs (Security.md §9.7): its SQL is written with $USER.*." },
          variables: arrayOf(ref("DashboardVariable")),
          tabs: DASHBOARD_TABS,
        })),
      },
      response: ok(ref("Dashboard")),
      schemas,
    }),
  },
    async (request) => {
      const body = optionalData(request.body);
      const dashboard = await context.dashboardsAdmin.update(request.params.id, {
        name: body.name,
        slug: body.slug,
        description: body.description,
        menuLabel: body.menuLabel,
        icon: body.icon,
        color: body.color,
        scope: body.scope,
        refreshIntervalSeconds: body.refreshIntervalSeconds,
        embeddingEnabled: body.embeddingEnabled,
        delegable: body.delegable,
        variables: body.variables,
        tabs: body.tabs,
      });
      return { data: dashboard };
    },
  );

  app.delete<{ Params: { id: string } }>("/admin/api/dashboards/:id", {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Delete a dashboard",
      description: "With its widgets, versions and role grants.",
      pathParameters: ID,
      response: NO_CONTENT,
    }),
  }, async (request, reply) => {
    await context.dashboardsAdmin.delete(request.params.id);
    reply.code(204);
  });

  // --- Roles that may view the published dashboard in Apps ---

  app.put<{ Params: { id: string }; Body: DataBody<{ roleIds: string[] }> }>(
    "/admin/api/dashboards/:id/roles",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Set the roles that may view it",
      description: "Replaces the whole grant set. Object access only: who may open the published dashboard in Apps (administrators always may).",
      pathParameters: ID,
      requestBody: { schema: dataEnvelope(object({ roleIds: arrayOf(UUID) }, ["roleIds"])) },
      response: ok({ ...arrayOf(UUID), description: "The granted role ids, deduplicated." }),
    }),
  },
    async (request) => {
      const roleIds = optionalData(request.body).roleIds;
      if (!Array.isArray(roleIds) || !roleIds.every((id) => typeof id === "string")) {
        throw new TotalBaseError("INVALID_QUERY", "roleIds must be an array of role ids.");
      }
      return { data: await context.dashboardsAdmin.setRoles(request.params.id, roleIds) };
    },
  );

  // --- Widgets ---

  app.get<{ Params: { id: string } }>(
    "/admin/api/dashboards/:id/widgets",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "List the draft's widgets",
      description: "Ordered by canvas position (row, then column).",
      pathParameters: ID,
      response: ok(arrayOf(ref("DashboardWidget"))),
      schemas,
    }),
  },
    async (request) => ({ data: await context.dashboardsAdmin.listWidgets(request.params.id) }),
  );

  app.post<{ Params: { id: string }; Body: DataBody<CreateWidgetBody> }>(
    "/admin/api/dashboards/:id/widgets",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Add a widget to the draft",
      description: "Its query and config may come with it - checked as a PATCH is (config, roles against the query, size at least the type's smallest), all before it is inserted: refused, nothing is left. Without them, inserted unconfigured.",
      pathParameters: ID,
      requestBody: { schema: dataEnvelope(object({ type: DASHBOARD_WIDGET_TYPE, label: { type: ["string", "null"] }, ...GRID, query: { type: ["string", "null"] }, config: { type: "object", additionalProperties: true }, tab: { type: ["string", "null"] } }, ["type", "gridX", "gridY", "gridW", "gridH"])) },
      response: created(ref("DashboardWidget")),
      schemas,
    }),
  },
    async (request, reply) => {
      const body = optionalData(request.body);
      const widget = await context.dashboardsAdmin.addWidget(request.params.id, {
        type: body.type as DashboardWidgetType,
        label: body.label,
        gridX: body.gridX as number,
        gridY: body.gridY as number,
        gridW: body.gridW as number,
        gridH: body.gridH as number,
        query: body.query,
        config: body.config,
        tab: body.tab,
      });
      reply.code(201);
      return { data: widget };
    },
  );

  app.patch<{ Params: { id: string; widgetId: string }; Body: DataBody<UpdateWidgetBody> }>(
    "/admin/api/dashboards/:id/widgets/:widgetId",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Update a draft widget",
      description:
        "Only the fields sent change. `type` may switch between data widgets (never to or from a presentation widget); without a `config` " +
        "of its own the switch keeps what both types share. `config` replaces the whole object and is validated against " +
        "the type's catalog properties. `query` (null or blank clears it) is stored as-is - PostgreSQL judges it when it runs.",
      pathParameters: WIDGET,
      requestBody: {
        schema: dataEnvelope(object({
          type: DASHBOARD_WIDGET_TYPE,
          label: { type: ["string", "null"] },
          ...GRID,
          query: { type: ["string", "null"], description: "Read-only SQL; may use `$USER.<column>` and `$VAR.<name>`." },
          config: { type: "object", additionalProperties: true },
          tab: { type: ["string", "null"], description: "Moves it to another tab (a value of the dashboard's tabs); null: the first." },
        })),
      },
      response: ok(ref("DashboardWidget")),
      schemas,
    }),
  },
    async (request) => {
      const body = optionalData(request.body);
      const widget = await context.dashboardsAdmin.updateWidget(request.params.id, request.params.widgetId, {
        type: body.type,
        label: body.label,
        gridX: body.gridX,
        gridY: body.gridY,
        gridW: body.gridW,
        gridH: body.gridH,
        query: body.query,
        config: body.config,
        tab: body.tab,
      });
      return { data: widget };
    },
  );

  app.delete<{ Params: { id: string; widgetId: string } }>(
    "/admin/api/dashboards/:id/widgets/:widgetId",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Delete a draft widget",
      description: "Published versions keep their own copy until the next publish.",
      pathParameters: WIDGET,
      response: NO_CONTENT,
    }),
  },
    async (request, reply) => {
      await context.dashboardsAdmin.deleteWidget(request.params.id, request.params.widgetId);
      reply.code(204);
    },
  );

  // --- Draft SQL execution (admin-only, read-only) ---
  // `$USER.*` resolves against the admin running it (request.admin.id -
  // requireAdmin sets `admin`, not `userId`).

  // The editor drawer's Run button - SQL typed but not saved yet.
  app.post<{ Params: { id: string }; Body: DataBody<{ query: string } & VariableValues> }>(
    "/admin/api/dashboards/:id/query",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Run ad-hoc widget SQL against the draft",
      description: `Executes \`query\` (not saved) with the draft's variable definitions. ${WIDGET_SQL_SEMANTICS}`,
      pathParameters: ID,
      requestBody: { schema: dataEnvelope(object({ query: { type: "string", description: "One SELECT-like statement; trailing semicolons are stripped." }, variables: DASHBOARD_VARIABLE_VALUES }, ["query"])) },
      response: ok(ref("DashboardQueryResult")),
      errors: ["422"],
      schemas,
    }),
  },
    async (request) => ({
      data: await context.dashboardsAdmin.executeDraftQuery(
        request.params.id,
        optionalData(request.body).query ?? "",
        await dashboardQueryLimits(context),
        await requestViewer(context, request),
        variableValues(request.body),
      ),
    }),
  );

  // The editor canvas - a widget's saved draft query, with the variables bar's current values.
  app.post<{ Params: { id: string; widgetId: string }; Body: DataBody<VariableValues> }>(
    "/admin/api/dashboards/:id/widgets/:widgetId/data",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Run a draft widget's saved query",
      description: `422 DASHBOARD_WIDGET_NOT_CONFIGURED when it has no query yet. ${WIDGET_SQL_SEMANTICS}`,
      pathParameters: WIDGET,
      requestBody: VALUES_BODY,
      response: ok(ref("DashboardDraftRun")),
      errors: ["422"],
      schemas,
    }),
  },
    async (request) => ({
      data: await withFileLinks(context, await context.dashboardsAdmin.executeDraftWidget(
        request.params.id,
        request.params.widgetId,
        await dashboardQueryLimits(context),
        await requestViewer(context, request),
        variableValues(request.body),
        await appLanguage(context),
      ), appFileScope(request.params.id, request.params.widgetId)),
    }),
  );

  // A SELECT variable's options for the editor's variables bar (draft definitions).
  app.post<{ Params: { id: string; name: string }; Body: DataBody<VariableValues> }>(
    "/admin/api/dashboards/:id/variables/:name/options",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "A draft SELECT variable's options",
      description:
        "A static list as-is, or the options query's rows (value, label) run read-only like widget SQL, capped at 500. " +
        "`variables` carries the current values: an options query may read other variables (`dependsOn`), bound like widget SQL. " +
        "404 DASHBOARD_VARIABLE_NOT_FOUND when the draft has no variable by that name; 422 DASHBOARD_VARIABLE_INVALID when it isn't a SELECT.",
      pathParameters: { ...ID, ...VARIABLE_NAME },
      requestBody: VALUES_BODY,
      response: ok(arrayOf(ref("DashboardVariableOption"))),
      errors: ["422"],
      schemas,
    }),
  },
    async (request) => ({
      data: await context.dashboardsAdmin.variableOptions(
        request.params.id,
        request.params.name,
        "DRAFT",
        await dashboardQueryLimits(context),
        await requestViewer(context, request),
        variableValues(request.body),
      ),
    }),
  );

  // --- Versions (Foundations.md §13.6 - same shape for dataviews/dashboards/workflows) ---

  app.post<{ Params: { id: string }; Body: DataBody<{ note?: string }> }>(
    "/admin/api/dashboards/:id/publish",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Publish the draft",
      description:
        "Snapshots the draft's widgets and variables as the next version - what Apps renders. A no-op returning the latest " +
        "version when the draft equals it; a draft equal to an older version is recorded as restored from it.",
      pathParameters: ID,
      requestBody: { schema: dataEnvelope(object({ note: { type: "string", maxLength: 128, description: "What this version changes - the publisher's note, shown in the object's Versions." } })), required: false },
      response: created(ref("DashboardVersion")),
      schemas,
    }),
  },
    async (request, reply) => {
      const version = await context.dashboardsAdmin.publish(request.params.id, request.admin?.id ?? null, publishNote(request.body));
      reply.code(201);
      return { data: version };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/dashboards/:id/versions",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "List versions",
      description: "Newest first, without snapshot content.",
      pathParameters: ID,
      response: ok(arrayOf(ref("DashboardVersion"))),
      schemas,
    }),
  },
    async (request) => ({ data: await context.dashboardsAdmin.listVersions(request.params.id) }),
  );

  app.get<{ Params: { id: string; version: string } }>(
    "/admin/api/dashboards/:id/versions/:version",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Get one version's content",
      pathParameters: VERSION,
      response: ok(ref("DashboardVersionSnapshot")),
      schemas,
    }),
  },
    async (request) => ({ data: await context.dashboardsAdmin.getVersion(request.params.id, versionParam(request.params.version)) }),
  );

  registerDeleteVersionsRoute(app, context, preHandler, "dashboards", (id, before) => context.dashboardsAdmin.deleteVersionsBefore(id, before));

  app.post<{ Params: { id: string; version: string } }>(
    "/admin/api/dashboards/:id/versions/:version/restore",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Restore a version into the draft",
      description: "Replaces the draft's widgets and variables with the version's (unsaved draft changes are lost). Publishes nothing - publish afterwards to make it live.",
      pathParameters: VERSION,
      response: ok(ref("Dashboard")),
      schemas,
    }),
  },
    async (request) => ({ data: await context.dashboardsAdmin.restore(request.params.id, versionParam(request.params.version)) }),
  );

  app.post<{ Params: { id: string }; Body: DataBody<{ name: string; slug?: string }> }>(
    "/admin/api/dashboards/:id/duplicate",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Duplicate a dashboard",
      description: "A new unpublished dashboard from this one's draft - identity under the new name, variables and widgets (fresh ids). No role grants, no embeds.",
      pathParameters: ID,
      requestBody: { schema: dataEnvelope(object({ name: IDENTITY.name, slug: IDENTITY.slug }, ["name"])) },
      response: created(ref("DashboardWithStatus")),
      schemas,
    }),
  },
    async (request, reply) => {
      const body = optionalData(request.body);
      const dashboard = await context.dashboardsAdmin.duplicate(request.params.id, { name: body.name ?? "", slug: body.slug });
      reply.code(201);
      return { data: dashboard };
    },
  );

  app.post<{ Params: { id: string; version: string }; Body: DataBody<{ name: string; slug?: string }> }>(
    "/admin/api/dashboards/:id/versions/:version/duplicate",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Save a version as a new dashboard",
      description: "A new unpublished dashboard whose draft is the version's content (fresh widget ids), identity copied, no role grants.",
      pathParameters: VERSION,
      requestBody: { schema: dataEnvelope(object({ name: IDENTITY.name, slug: IDENTITY.slug }, ["name"])) },
      response: created(ref("DashboardWithStatus")),
      schemas,
    }),
  },
    async (request, reply) => {
      const body = optionalData(request.body);
      const dashboard = await context.dashboardsAdmin.duplicateVersion(request.params.id, versionParam(request.params.version), {
        name: body.name ?? "",
        slug: body.slug,
      });
      reply.code(201);
      return { data: dashboard };
    },
  );

  app.post<{ Params: { id: string; version: string; name: string }; Body: DataBody<VariableValues> }>(
    "/admin/api/dashboards/:id/versions/:version/variables/:name/options",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "A version's SELECT variable options",
      description: "As the draft's options route, but with the definitions in that version's snapshot (the read-only preview).",
      pathParameters: { ...VERSION, ...VARIABLE_NAME },
      requestBody: VALUES_BODY,
      response: ok(arrayOf(ref("DashboardVariableOption"))),
      errors: ["422"],
      schemas,
    }),
  },
    async (request) => ({
      data: await context.dashboardsAdmin.variableOptions(
        request.params.id,
        request.params.name,
        versionParam(request.params.version),
        await dashboardQueryLimits(context),
        await requestViewer(context, request),
        variableValues(request.body),
      ),
    }),
  );

  // The read-only preview renders a version's widgets from ITS snapshot (query + variable definitions).
  app.post<{ Params: { id: string; version: string; widgetId: string }; Body: DataBody<VariableValues> }>(
    "/admin/api/dashboards/:id/versions/:version/widgets/:widgetId/data",
    {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Run a version's widget",
      description: `The widget's query and variable definitions come from that version's snapshot, never the caller. ${WIDGET_SQL_SEMANTICS}`,
      pathParameters: { ...VERSION, widgetId: WIDGET.widgetId },
      requestBody: VALUES_BODY,
      response: ok(ref("DashboardQueryResult")),
      errors: ["422"],
      schemas,
    }),
  },
    async (request) => ({
      data: await withFileLinks(context, await context.dashboardsAdmin.executeVersionWidget(
        request.params.id,
        versionParam(request.params.version),
        request.params.widgetId,
        await dashboardQueryLimits(context),
        await requestViewer(context, request),
        variableValues(request.body),
      ), appFileScope(request.params.id, request.params.widgetId)),
    }),
  );
}
