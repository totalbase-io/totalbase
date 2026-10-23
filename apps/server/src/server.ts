import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { DocumentedRoute, RouteInfo } from "@totalbase/openapi";
import { registerAdminUi, routeNotFound } from "./admin-ui.js";
import { registerMcpEndpoint } from "./mcp-endpoint.js";
import type { AppContext } from "./context.js";
import { catalogChanged } from "./invalidations.js";
import { FASTIFY_BODY_LIMIT_CEILING, maxHeaderSizeFor, parseQueryString, registerHardeningHooks } from "./hardening.js";
import { registerAccessAudit } from "./access-audit.js";
import { registerHealthRoutes } from "./health.js";
import { registerApiAuthRoutes } from "./routes/api-auth.js";
import { registerAdminAuthRoutes } from "./routes/admin-auth.js";
import { registerAdminUsersRoutes } from "./routes/admin-users.js";
import { registerAdminRolesRoutes } from "./routes/admin-roles.js";
import { registerAdminTokensRoutes } from "./routes/admin-tokens.js";
import { registerTokensRoutes } from "./routes/tokens.js";
import { registerAdminSessionsRoutes } from "./routes/admin-sessions.js";
import { registerAdminPermissionsRoutes } from "./routes/admin-permissions.js";
import { registerAdminEffectivePermissionsRoutes } from "./routes/admin-effective-permissions.js";
import { registerAdminCatalogRoutes } from "./routes/admin-catalog.js";
import { registerAdminResourcesRoutes } from "./routes/admin-resources.js";
import { registerAdminDashboardsRoutes } from "./routes/admin-dashboards.js";
import { registerAdminDashboardsSuggestRoutes } from "./routes/admin-dashboards-suggest.js";
import { registerAdminDataViewsRoutes } from "./routes/admin-dataviews.js";
import { registerAdminDiagnosisRoutes, registerViewAsRoute } from "./routes/admin-diagnosis.js";
import { nameRolesInRefusal, registerViewAsGuard } from "./view-as.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerAppDashboardsRoutes } from "./routes/app-dashboards.js";
import { registerAppMenuRoutes } from "./routes/app-menu.js";
import { registerAppMapTilesRoutes } from "./routes/app-map-tiles.js";
import { embedFrameAncestors, registerEmbedDashboardsRoutes } from "./routes/embed-dashboards.js";
import { registerAdminDashboardEmbedsRoutes } from "./routes/admin-dashboard-embeds.js";
import { registerInstanceRoutes } from "./routes/instance.js";
import { registerAdminThemeRoutes } from "./routes/admin-theme.js";
import { registerAppDataViewsRuntimeRoutes } from "./routes/app-dataviews-runtime.js";
import { registerAppDataViewSaveRoutes } from "./routes/app-dataviews-save.js";
import { registerAppDataViewBulkRoutes } from "./routes/app-dataviews-bulk.js";
import { registerAppTemplatesRoutes } from "./routes/app-templates.js";
import { registerAppUsersRoutes } from "./routes/app-users.js";
import { registerAppMeRoutes } from "./routes/app-me.js";
import { registerAppDataViewsRoutes } from "./routes/app-dataviews.js";
import { registerAdminAuditRoutes } from "./routes/admin-audit.js";
import { registerAdminAuthProvidersRoutes } from "./routes/admin-auth-providers.js";
import { registerAdminSecretsRoutes } from "./routes/admin-secrets.js";
import { registerAdminMaintenanceRoutes } from "./routes/admin-maintenance.js";
import { registerAdminBackupsRoutes } from "./routes/admin-backups.js";
import { registerAdminSettingsRoutes } from "./routes/admin-settings.js";
import { registerAdminSystemEmailsRoutes } from "./routes/admin-system-emails.js";
import { registerAdminDashboardRoutes } from "./routes/admin-dashboard.js";
import { registerAdminSchemaRoutes } from "./routes/admin-schema.js";
import { registerAdminSqlConsoleRoutes } from "./routes/admin-sql-console.js";
import { registerAdminWorkflowsRoutes } from "./routes/admin-workflows.js";
import { registerWorkflowWebhookRoutes } from "./routes/workflow-webhooks.js";
import { registerWorkflowRunRoutes } from "./routes/workflow-run.js";
import { registerDataTableRoutes } from "./routes/data-table.js";
import { registerDataTableMutationRoutes } from "./routes/data-table-mutations.js";
import { registerDataViewRoutes } from "./routes/data-view.js";
import { registerDataFunctionRoutes } from "./routes/data-function.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerTemplatesRoutes } from "./routes/templates.js";
import { registerTransactionRoutes } from "./routes/transactions.js";
import { registerExecutionRoutes } from "./routes/executions.js";
import { registerOpenApiRoutes } from "./routes/openapi.js";

/**
 * apps/server stays thin: Fastify bootstrap, route registration,
 * HTTP serialization. No domain logic here (AGENTS.md section 6).
 */
/** A request's URL as the log keeps it: no query string, an embed's key masked (its path is the secret). */
export function redactedUrl(url: string): string {
  const path = url.split("?")[0] ?? "";
  return path.replace(/^(\/embed\/)(?!api\/)[^/]+/, "$1[redacted]");
}

export async function buildServer(
  context: AppContext,
  logLevel: string,
  adminUi: { enabled: boolean; dir?: string | undefined; devProxyTarget?: string | undefined } = { enabled: true },
) {
  // A Fastify construction option, so read once: security.trust_proxy
  // applies after a restart (Administration.md §7.5, §7.7).
  // Every other hardening setting is read per request (hardening.ts).
  const trustProxy = await context.settings.get("security.trust_proxy");
  // Node's header limit, also read once: big enough for a query string of
  // api.max_query_string_bytes to reach the hardening hook (and its
  // QUERY_STRING_TOO_LARGE) instead of Node's raw 431. Raising the setting
  // live past it takes a restart (Data_API.md §12.1).
  const maxHeaderSize = maxHeaderSizeFor(await context.settings.get("api.max_query_string_bytes"));

  const app = Fastify({
    logger: {
      level: logLevel,
      // What a request line logs: never its query string - a password-reset,
      // invitation or verification token travels in `?token=`, OAuth's callback carries `code` and `state`
      // - and never a public embed's key, which is its path (`/embed/tbe_…`).
      serializers: {
        req: (request) => ({
          method: request.method,
          url: redactedUrl(request.url ?? ""),
          hostname: request.hostname,
          remoteAddress: request.ip,
        }),
      },
    },
    // The Data API's query language relies on PHP-style bracket nesting
    // (where[price][_gt]=100); Fastify's default parser is flat.
    querystringParser: parseQueryString,
    // audit_logs.request_id / outbox_events.request_id are uuid columns;
    // Fastify's default genReqId is a plain incrementing counter.
    genReqId: () => randomUUID(),
    bodyLimit: FASTIFY_BODY_LIMIT_CEILING,
    trustProxy,
    http: { maxHeaderSize },
  });

  // Lets the MCP endpoint's in-process calls past the per-IP limit (it limits its own callers per token); made here, never stored or sent.
  const internalKey = randomBytes(32).toString("hex");
  registerHardeningHooks(app, context.settings, { internalKey });
  registerViewAsGuard(app);
  registerAccessAudit(app, context);

  // Collected for GET /admin/api/openapi (@totalbase/openapi's
  // buildAdminOpenApiSpec) - onRoute fires synchronously as each route()
  // call below registers, so registering openapi routes last captures
  // every admin route registered before it.
  const adminRoutes: RouteInfo[] = [];
  // Likewise for the Data API document: fixed /api/* routes (auth, tokens,
  // files, ...) that declare `config.openapi`. Catalog routes (tables,
  // views, functions) and workflows are generated from their own sources.
  // Read lazily at request time, so plugin-scoped routes (files.ts)
  // registered after this point are included too.
  const dataRoutes: DocumentedRoute[] = [];
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const doc = routeOptions.config?.openapi;
    if (doc && routeOptions.url.startsWith("/api/")) {
      for (const method of methods) if (method !== "HEAD") dataRoutes.push({ method, url: routeOptions.url, doc });
    }
    if (!routeOptions.url.startsWith("/admin/api/")) return;
    // admin-ui.ts's "/admin/api/*" catch-all only answers 404 for an
    // unknown path - not an operation to document.
    if (routeOptions.url.includes("*")) return;
    const isPublic = routeOptions.config?.public === true;
    for (const method of methods) adminRoutes.push({ method, url: routeOptions.url, public: isPublic, ...(doc ? { doc } : {}) });
  });

  // openapi.cache_enabled (openapi-cache.ts): data changes are tracked by
  // PostgreSQL itself; an Admin API write may also be DDL (schema
  // management, the SQL Console), which only the server can see. The rule:
  // flush on a successful (2xx) non-GET under /admin/api/, except the
  // auth routes. A failed request changed nothing (a wrong password, a
  // 404, a validation error), and signing in or out of the admin can't
  // change a document - both used to drop every cached document, on every
  // failed login too. Any other admin write may (a setting, a permission,
  // a resource, DDL), and telling those apart per route isn't worth a
  // stale document, so the rest of the plane still flushes. Same reasoning
  // for what getRelationDetail() introspected (@totalbase/pg-catalog's
  // relation-detail-cache.ts) and widget plans - a backstop: the DDL paths
  // themselves (schema management's reconcile, the SQL Console service)
  // already clear them. Every other process is told too (invalidations.ts).
  app.addHook("onResponse", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    if (!request.url.startsWith("/admin/api/") || request.url.startsWith("/admin/api/auth/")) return;
    await catalogChanged(context).catch((error: unknown) => request.log.warn({ error }, "catalog invalidation signal failed"));
  });

  // Any path nothing answers - another method on an SPA path, any unknown
  // path of an API-only instance: the error envelope, never Fastify's own
  // body (Foundations.md §4.1).
  app.setNotFoundHandler(async (request) => {
    throw routeNotFound(request);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof TotalBaseError) {
      // Seeing the App as someone (view-as.ts): a refusal names their roles.
      reply.code(error.httpStatus).send({ errors: error.toPublicErrors().map((e) => ({ ...e, message: nameRolesInRefusal(request, String(e.message)) })) });
      return;
    }
    // Fastify's own bodyLimit rejection (Data_API.md §12: REQUEST_BODY_TOO_LARGE).
    if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413).send({
        errors: [{ source: "TOTALBASE", code: "REQUEST_BODY_TOO_LARGE", message: "Request body exceeds the configured size limit." }],
      });
      return;
    }
    // Any other Fastify client error (malformed JSON, an empty body sent as
    // application/json, an unsupported content type...) carries its own
    // 4xx statusCode - the caller's mistake, not a 500. Fastify's messages
    // describe only the request itself, so they're safe to return.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({
        errors: [{ source: "TOTALBASE", code: "INVALID_QUERY", message: (error as Error).message }],
      });
      return;
    }
    app.log.error(error);
    reply.code(500).send({
      errors: [{ source: "TOTALBASE", code: "INTERNAL_ERROR", message: "Internal server error." }],
    });
  });

  registerHealthRoutes(app, context.database);
  registerApiAuthRoutes(app, context);
  registerAdminAuthRoutes(app, context);
  registerAdminUsersRoutes(app, context);
  registerAdminRolesRoutes(app, context);
  registerAdminTokensRoutes(app, context);
  registerAdminSessionsRoutes(app, context);
  registerAdminPermissionsRoutes(app, context);
  registerAdminEffectivePermissionsRoutes(app, context);
  registerAdminCatalogRoutes(app, context);
  registerAdminResourcesRoutes(app, context);
  registerAdminDataViewsRoutes(app, context);
  registerAdminDiagnosisRoutes(app, context);
  registerViewAsRoute(app, context);
  registerSetupRoutes(app, context);
  registerAppDataViewsRoutes(app, context);
  registerAdminDashboardsRoutes(app, context);
  registerAdminDashboardsSuggestRoutes(app, context);
  registerAppDashboardsRoutes(app, context);
  registerAppMenuRoutes(app, context);
  registerAppMapTilesRoutes(app, context);
  registerEmbedDashboardsRoutes(app, context);
  registerAdminDashboardEmbedsRoutes(app, context);
  registerInstanceRoutes(app, context);
  registerAdminThemeRoutes(app, context);
  registerAppDataViewsRuntimeRoutes(app, context);
  registerAppDataViewSaveRoutes(app, context);
  registerAppDataViewBulkRoutes(app, context);
  registerAppTemplatesRoutes(app, context);
  registerAppUsersRoutes(app, context);
  registerAppMeRoutes(app, context);
  registerAdminAuditRoutes(app, context);
  registerAdminAuthProvidersRoutes(app, context);
  registerAdminSecretsRoutes(app, context);
  registerAdminSettingsRoutes(app, context, { trustProxy });
  registerAdminSystemEmailsRoutes(app, context);
  registerAdminDashboardRoutes(app, context);
  registerAdminSchemaRoutes(app, context);
  registerAdminSqlConsoleRoutes(app, context);
  registerAdminMaintenanceRoutes(app, context);
  registerAdminBackupsRoutes(app, context);
  registerAdminWorkflowsRoutes(app, context);
  registerMcpEndpoint(app, context, internalKey);
  registerWorkflowWebhookRoutes(app, context);
  registerWorkflowRunRoutes(app, context);
  registerDataTableRoutes(app, context);
  registerDataTableMutationRoutes(app, context);
  registerDataViewRoutes(app, context);
  registerDataFunctionRoutes(app, context);
  registerFilesRoutes(app, context);
  registerTemplatesRoutes(app, context);
  registerTransactionRoutes(app, context);
  registerExecutionRoutes(app, context);
  registerTokensRoutes(app, context);
  registerOpenApiRoutes(app, context, adminRoutes, dataRoutes);
  await registerAdminUi(app, adminUi.enabled, adminUi.dir, adminUi.devProxyTarget, (path) => embedFrameAncestors(context, path));

  return app;
}
