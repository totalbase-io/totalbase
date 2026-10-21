import type { DocumentedRoute, RouteAccess } from "./route-docs.js";

/** What an endpoint belongs to: a catalog resource, a workflow, or a fixed TotalBase route (auth, tokens, files, ...). */
export type ApiEndpointKind = "TABLE" | "VIEW" | "FUNCTION" | "WORKFLOW" | "SYSTEM";

/**
 * One route of the instance's developer-facing HTTP surface, as the admin's
 * Endpoints screen lists it (Admin_UI.md §12): every
 * Data API route of every ACTIVE resource - a method outside its
 * `exposed_methods` listed as disabled -, every workflow's run/webhook
 * route, and every fixed `/api/*` route that declares `config.openapi`.
 * Not principal-effective: what a given role may call is the Data API
 * OpenAPI document's job.
 */
export interface ApiEndpoint {
  method: string;
  /** OpenAPI-style path (`{pk}`, `{id}`), relative to system.public_url. */
  path: string;
  kind: ApiEndpointKind;
  /** The resource's or workflow's name; a fixed route's summary. */
  name: string;
  /** PostgreSQL schema (resources only). */
  schema: string | null;
  /** resources.id (resources only). */
  resource: string | null;
  /** workflows.id (workflows only). */
  workflow: string | null;
  /** Whether the route answers right now. */
  enabled: boolean;
  access: RouteAccess;
  /** The OpenAPI tag the Data API document files it under. */
  tag: string;
}

export interface EndpointResource {
  id: string;
  schema: string;
  name: string;
  type: "TABLE" | "VIEW" | "FUNCTION";
  exposedMethods: string[];
}

export interface EndpointWorkflow {
  id: string;
  name: string;
  slug: string;
  /** The Start step's trigger; DATA_EVENT (no HTTP caller) and anything else are skipped. */
  trigger: string | null;
  /** WEBHOOK only. */
  method: "GET" | "POST";
  access: "PUBLIC" | "AUTHENTICATED";
  /** Enabled and published - what the run/webhook routes admit. */
  live: boolean;
}

const ROUTE_PARAM = /:([A-Za-z0-9_]+)/g;

/**
 * Same paths the Data API mounts (apps/server's data-table*.ts, data-view.ts,
 * data-function.ts). A table's `{pk}` routes need a single-column primary
 * key; they're listed regardless (a composite key answers 400 there).
 */
function resourceEndpoints(resource: EndpointResource): ApiEndpoint[] {
  const base = `/api/${resource.schema}/${resource.type.toLowerCase()}/${resource.name}`;
  const routes: [string, string][] =
    resource.type === "TABLE"
      ? [["GET", base], ["GET", `${base}/{pk}`], ["POST", base], ["PATCH", base], ["PATCH", `${base}/{pk}`], ["DELETE", base], ["DELETE", `${base}/{pk}`]]
      : resource.type === "VIEW"
        ? [["GET", base]]
        : [["POST", base]];
  return routes.map(([method, path]) => ({
    method,
    path,
    kind: resource.type,
    name: resource.name,
    schema: resource.schema,
    resource: resource.id,
    workflow: null,
    enabled: resource.exposedMethods.includes(method),
    access: "principal",
    tag: resource.schema,
  }));
}

function workflowEndpoint(workflow: EndpointWorkflow): ApiEndpoint | undefined {
  const webhook = workflow.trigger === "WEBHOOK";
  if (!webhook && workflow.trigger !== "MANUAL" && workflow.trigger !== "CRON") return undefined;
  return {
    method: webhook ? workflow.method : "POST",
    path: `/api/workflows/${workflow.slug}/${webhook ? "webhook" : "run"}`,
    kind: "WORKFLOW",
    name: workflow.name,
    schema: null,
    resource: null,
    workflow: workflow.id,
    enabled: workflow.live,
    access: webhook && workflow.access === "PUBLIC" ? "public" : "principal",
    tag: "workflows",
  };
}

/** Every endpoint, resources first (by schema, name), then workflows, then fixed routes - each in its source's order. */
export function listApiEndpoints(input: {
  resources: EndpointResource[];
  workflows: EndpointWorkflow[];
  routes: DocumentedRoute[];
}): ApiEndpoint[] {
  const workflows = input.workflows.map(workflowEndpoint).filter((endpoint): endpoint is ApiEndpoint => endpoint !== undefined);
  return [
    ...input.resources.flatMap(resourceEndpoints),
    ...workflows,
    // A run's result, once any workflow can be started over HTTP (workflow-spec.ts lists it the same way).
    ...(workflows.length > 0
      ? [{
          method: "GET",
          path: "/api/workflows/runs/{runId}/result",
          kind: "WORKFLOW" as const,
          name: "Get the final result of a run you started",
          schema: null,
          resource: null,
          workflow: null,
          enabled: true,
          access: "principal" as const,
          tag: "workflows",
        }]
      : []),
    ...input.routes.map((route) => ({
      method: route.method.toUpperCase(),
      path: route.url.replace(ROUTE_PARAM, "{$1}"),
      kind: "SYSTEM" as const,
      name: route.doc.summary,
      schema: null,
      resource: null,
      workflow: null,
      enabled: true,
      access: route.doc.access,
      tag: route.doc.tags[0] ?? "system",
    })),
  ];
}
