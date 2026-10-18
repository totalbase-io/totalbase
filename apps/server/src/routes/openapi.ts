import { UUID_PATTERN } from "@totalbase/shared";
import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import {
  buildAdminOpenApiSpec,
  buildPublicOpenApiSpec,
  listApiEndpoints,
  type DocumentedRoute,
  type EndpointWorkflow,
  type RouteInfo,
  type WorkflowEndpoint,
} from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAdmin } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { protectedFieldDecision, guardedColumnsWriteFieldDecision } from "@totalbase/mutations";
import { adminDoc, arrayOf, object, ok } from "../openapi-admin-docs.js";


type StartConfiguration = Record<string, unknown>;
const startConfiguration = (definition: Record<string, unknown>): StartConfiguration => {
  const operations = (definition.operations as { type: string; configuration: StartConfiguration }[] | undefined) ?? [];
  return operations.find((op) => op.type === "totalbase.start")?.configuration ?? {};
};

/**
 * The workflows `roleIds` may invoke, as their HTTP surface: the same
 * enabled+published set and Start-step trigger rules the run/webhook
 * routes admit (workflow-run.ts, workflow-webhooks.ts), gated by the same
 * INVOKE grant. DATA_EVENT workflows have no HTTP caller and are skipped.
 */
async function invokableWorkflows(context: AppContext, roleIds: string[]): Promise<WorkflowEndpoint[]> {
  const endpoints: WorkflowEndpoint[] = [];
  for (const { workflow, definition } of await context.workflowsAdmin.listEnabledPublished()) {
    const config = startConfiguration(definition);
    const trigger = config.trigger;
    if (trigger !== "MANUAL" && trigger !== "CRON" && trigger !== "WEBHOOK") continue;
    if ((await context.workflowPermissions.resolveInvoke(roleIds, workflow.id)) !== "ALLOW") continue;
    endpoints.push({
      slug: workflow.slug,
      name: workflow.name,
      description: workflow.description,
      trigger,
      method: config.method === "GET" ? "GET" : "POST",
      access: config.access === "AUTHENTICATED" ? "AUTHENTICATED" : "PUBLIC",
      responseMode: config.response_mode === "ASYNC" ? "ASYNC" : "SYNC",
    });
  }
  return endpoints;
}

/**
 * Every workflow with an HTTP surface, for the Endpoints list: a live one
 * (enabled + published) as its published Start step configures it, any
 * other as its draft does - disabled until it is both.
 */
async function endpointWorkflows(context: AppContext): Promise<EndpointWorkflow[]> {
  const live = new Map((await context.workflowsAdmin.listEnabledPublished()).map((entry) => [entry.workflow.id, entry]));
  const workflows: EndpointWorkflow[] = [];
  for (const workflow of await context.workflowsAdmin.list()) {
    const published = live.get(workflow.id);
    if (!published && workflow.triggerType !== "MANUAL" && workflow.triggerType !== "CRON" && workflow.triggerType !== "WEBHOOK") continue;
    const config = startConfiguration(published?.definition ?? (await context.workflowsAdmin.getDraft(workflow.id)).definition);
    workflows.push({
      id: workflow.id,
      name: workflow.name,
      slug: workflow.slug,
      trigger: typeof config.trigger === "string" ? config.trigger : null,
      method: config.method === "GET" ? "GET" : "POST",
      access: config.access === "AUTHENTICATED" ? "AUTHENTICATED" : "PUBLIC",
      live: published !== undefined,
    });
  }
  return workflows;
}

/** The two document routes answer the bare OpenAPI document, not the `{ data }` envelope. */
const OPENAPI_DOCUMENT = { status: "200" as const, schema: { type: "object", description: "An OpenAPI 3.1 document", additionalProperties: true } };

const ENDPOINT_SCHEMA = object({
  method: { type: "string" },
  path: { type: "string", description: "OpenAPI path syntax, relative to system.public_url." },
  kind: { type: "string", enum: ["TABLE", "VIEW", "FUNCTION", "WORKFLOW", "SYSTEM"] },
  name: { type: "string" },
  schema: { type: ["string", "null"] },
  resource: { type: ["string", "null"], format: "uuid" },
  workflow: { type: ["string", "null"], format: "uuid" },
  enabled: { type: "boolean", description: "Whether the route answers right now (an exposed method; an enabled, published workflow)." },
  access: { type: "string", enum: ["public", "session", "principal"] },
  tag: { type: "string" },
});

/** The Data API document for `roleIds`, with the same always-on field guardrails the Data API itself applies. */
async function buildDataApiSpec(context: AppContext, dataRoutes: DocumentedRoute[], roleIds: string[], principalType: "USER" | "API_KEY") {
  // Which guarded columns the viewer may write depends on whether they are
  // an administrator (an admin_access role) - the same test the writes use.
  const caller = { administrator: await context.effectivePermissions.isAdministrators(roleIds) };
  const build = async () => buildPublicOpenApiSpec(context.database, context.effectivePermissions, roleIds, {
    publicUrl: await context.auth.mailer.publicUrl(),
    principalType,
    routes: dataRoutes,
    workflows: await invokableWorkflows(context, roleIds),
    includeExamples: await context.settings.get("openapi.include_examples"),
    idempotencyEnabled: await context.settings.get("idempotency.enabled"),
    guardFieldDecision: (resource, action, decision) => {
      const guarded = protectedFieldDecision(resource, decision);
      return action === "CREATE" || action === "UPDATE" ? guardedColumnsWriteFieldDecision(resource, guarded, caller) : guarded;
    },
  });
  if (!(await context.settings.get("openapi.cache_enabled"))) return build();
  return context.openApiCache.get(`${principalType}:${[...roleIds].sort().join(",")}`, build);
}

/**
 * OpenAPI endpoints (Specification_Data_API.md §14). Both documents are
 * generated on every request from live catalog/resources/permissions
 * state - "Never manually edited". `servers` comes from
 * system.public_url (env fallback), never the request's Host header
 * (AGENTS.md section 19A).
 */
export function registerOpenApiRoutes(
  app: FastifyInstance,
  context: AppContext,
  adminRoutes: RouteInfo[],
  dataRoutes: DocumentedRoute[],
): void {
  // Public: GET /api/openapi.json - "principal-effective spec"
  // (Specification_Data_API.md §14.1), so it requires the same bearer auth as the rest of the Data API;
  // there is no anonymous/public role concept in V1 to fall back to.
  app.get("/api/openapi.json", async (request) => {
    // openapi.enabled off: the Data API document isn't published. The
    // admin's own view of it (below) stays - admins still need it.
    if (!(await context.settings.get("openapi.enabled"))) {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", "The OpenAPI document is not published on this instance.");
    }
    const token = extractBearerToken(request);
    const dataPrincipal = await resolveDataPrincipal(context, token);
    const principalType = dataPrincipal.principal.type === "API_KEY" ? "API_KEY" : "USER";
    return buildDataApiSpec(context, dataRoutes, dataPrincipal.roleIds, principalType);
  });

  // The same principal-effective Data API document, as one role sees it -
  // lets an admin check what a role's API consumers get without holding a
  // token for that role. Reads only; the admin's own roles play no part.
  // `as=api_key` shows it as an API key holding the role would (no
  // session-only routes); the default is a signed-in user with the role.
  app.get<{ Querystring: { role?: string; as?: string } }>(
    "/admin/api/openapi/data",
    {
      preHandler: requireAdmin(context),
      ...adminDoc("openapi", {
        summary: "The Data API document as one role sees it",
        description:
          "The principal-effective OpenAPI 3.1 document GET /api/openapi.json would give a holder of `role` - only what its permissions " +
          "allow, with the same field guardrails. Answers the bare document, not a `{ data }` envelope. 404 for an unknown role.",
        parameters: [
          { name: "role", in: "query", required: true, schema: { type: "string", format: "uuid" } },
          {
            name: "as",
            in: "query",
            schema: { type: "string", enum: ["user", "api_key"], default: "user" },
            description: "`api_key`: as an API key holding the role sees it (no session-only routes); `user`: a signed-in user with the role.",
          },
        ],
        response: OPENAPI_DOCUMENT,
      }),
    },
    async (request) => {
      const roleId = request.query.role;
      if (!roleId) throw new TotalBaseError("INVALID_QUERY", 'The "role" query parameter is required.');
      if (!UUID_PATTERN.test(roleId) || !(await context.roles.findById(roleId))) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "Role not found.");
      }
      return buildDataApiSpec(context, dataRoutes, [roleId], request.query.as === "api_key" ? "API_KEY" : "USER");
    },
  );

  // The Endpoints screen (Specification_Admin_UI.md §12): the whole
  // developer-facing surface, not one role's view of it.
  app.get(
    "/admin/api/endpoints",
    {
      preHandler: requireAdmin(context),
      ...adminDoc("openapi", {
        summary: "Every Data API endpoint of the instance",
        description: "Each exposed resource's routes (a method it doesn't expose listed as disabled), each HTTP-triggered workflow's route, and the fixed /api/* routes. Not principal-effective - see GET /openapi/data for a role's view.",
        response: ok(arrayOf(ENDPOINT_SCHEMA)),
      }),
    },
    async () => {
      const resources = (await context.resourcesAdmin.list()).filter((resource) => resource.status === "ACTIVE" && resource.exposedMethods.length > 0);
      return { data: listApiEndpoints({ resources, workflows: await endpointWorkflows(context), routes: dataRoutes }) };
    },
  );

  app.get("/admin/api/openapi", {
    preHandler: requireAdmin(context),
    ...adminDoc("openapi", {
      summary: "The Admin API document",
      description: "This document: every /admin/api/* route, generated from the routes' own documentation. Answers the bare document, not a `{ data }` envelope.",
      response: OPENAPI_DOCUMENT,
    }),
  }, async () => {
    return buildAdminOpenApiSpec(adminRoutes, { publicUrl: await context.auth.mailer.publicUrl() });
  });
}
