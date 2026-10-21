import type { FastifyInstance } from "fastify";
import { objectReachIssues, type DiagnosisIssue } from "@totalbase/dataviews";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { type DataBody, requestData } from "../request-body.js";
import { loadViewAsTarget } from "../view-as.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, object, ok, UUID } from "../openapi-admin-docs.js";

/**
 * What stops an App object from working, and for whom (DataViews.md §18): a DataView's, a
 * dashboard's, and every one at once - what the admin's warnings, the publish dialog and the MCP's `check_app`
 * read. The checks are @totalbase/dataviews'; every answer about a role is the Permission Resolver's.
 */
const NAMED = object({ id: UUID, name: { type: "string" } }, ["id", "name"]);
const ISSUE = object({
  code: { type: "string", enum: ["NOT_PUBLISHED", "NO_ROLES", "BROKEN_REFERENCE", "CONSTRAINT_WITHOUT_MESSAGE", "ROLE_CANNOT_READ", "ROLE_FIELDS_HIDDEN", "ROLE_SEES_KEY", "ROLE_VARIABLE_REFUSED", "ROLE_CANNOT_WRITE"] },
  severity: { type: "string", enum: ["warning", "info"] },
  message: { type: "string", description: "The issue in English." },
  role: { ...NAMED, type: ["object", "null"], description: "The role it is about - null for the object itself." },
  resource: { ...NAMED, type: ["object", "null"], description: "The source, or a Resource variable's resource." },
  actions: { type: ["array", "null"], items: { type: "string", enum: ["CREATE", "UPDATE", "DELETE"] }, description: "ROLE_CANNOT_WRITE: what the role lacks." },
  columns: { type: ["array", "null"], items: { type: "string" }, description: "The columns or related paths." },
  variable: { type: ["string", "null"], description: "ROLE_VARIABLE_REFUSED: the variable." },
}, ["code", "severity", "message", "role", "resource", "actions", "columns", "variable"]);

export function registerAdminDiagnosisRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  async function dashboardIssues(dashboard: { id: string; liveVersion?: number | null }): Promise<DiagnosisIssue[]> {
    const roles = await context.dashboardsAdmin.listRoles(dashboard.id);
    return (await objectReachIssues(context, "dashboard", { id: dashboard.id, liveVersion: dashboard.liveVersion ?? null }, roles)).issues;
  }

  app.get<{ Params: { id: string } }>("/admin/api/dataviews/:id/diagnosis", {
    preHandler,
    ...adminDoc("dataviews", {
      summary: "What stops a DataView from working, and for whom",
      description:
        "Not published, no role opens it, a column its source no longer has; and per role that " +
        "opens it: no READ on its source, columns it may not read, a foreign key it sees as a key, a page variable " +
        "refused, a write the DataView offers but the role may not make (`info`). Decided by the Permission Resolver; " +
        "never grants anything.",
      pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
      response: ok(arrayOf(ISSUE)),
    }),
  }, async (request) => {
    const view = await context.dataviewsAdmin.get(request.params.id);
    return { data: await context.dataviewsAdmin.diagnose(view.id, context.effectivePermissions) };
  });

  app.get<{ Params: { id: string } }>("/admin/api/dashboards/:id/diagnosis", {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "What stops a dashboard from reaching its viewers",
      description: "Not published, no role opens it. A dashboard's data is its author's (its SQL), so no role lacks a grant on it.",
      pathParameters: { id: { description: "The dashboard's id.", schema: UUID } },
      response: ok(arrayOf(ISSUE)),
    }),
  }, async (request) => {
    const dashboard = (await context.dashboardsAdmin.list()).find((d) => d.id === request.params.id) ?? await context.dashboardsAdmin.get(request.params.id);
    return { data: await dashboardIssues(dashboard) };
  });

  app.get("/admin/api/diagnosis", {
    preHandler,
    ...adminDoc("dataviews", {
      summary: "Every DataView and dashboard with something stopping it",
      description: "The two checks above over the whole App, only the objects with an issue - what an agent reads to verify its own build (MCP `check_app`).",
      response: ok(arrayOf(object({
        kind: { type: "string", enum: ["DATAVIEW", "DASHBOARD"] },
        id: UUID,
        name: { type: "string" },
        slug: { type: "string" },
        issues: arrayOf(ISSUE),
      }, ["kind", "id", "name", "slug", "issues"]))),
    }),
  }, async () => {
    const found: { kind: "DATAVIEW" | "DASHBOARD"; id: string; name: string; slug: string; issues: DiagnosisIssue[] }[] = [];
    for (const view of await context.dataviewsAdmin.list()) {
      const issues = await context.dataviewsAdmin.diagnose(view.id, context.effectivePermissions);
      if (issues.length) found.push({ kind: "DATAVIEW", id: view.id, name: view.name, slug: view.slug, issues });
    }
    for (const dashboard of await context.dashboardsAdmin.list()) {
      const issues = await dashboardIssues(dashboard);
      if (issues.length) found.push({ kind: "DASHBOARD", id: dashboard.id, name: dashboard.name, slug: dashboard.slug, issues });
    }
    return { data: found };
  });
}

/**
 * Starting See as (Security.md §8.4): checks the role or user and records who previews whom in the
 * audit log - an access event, like a session. The preview itself is the header the admin then sends (view-as.ts).
 */
export function registerViewAsRoute(app: FastifyInstance, context: AppContext): void {
  app.post<{ Body: DataBody<{ kind?: unknown; id?: unknown }> }>("/admin/api/view-as", {
    preHandler: requireAdmin(context),
    ...adminDoc("dataviews", {
      summary: "Start seeing the App as a role or a user",
      description:
        "Checks the target - an active role, or an active user (with their effective roles and their $USER) - and records " +
        "the preview in the audit log. The admin then sends `X-TotalBase-View-As: role:<id>` or `user:<id>` on its App and " +
        "Data API requests: the Permission Resolver decides with the target's roles; every write is refused (403 " +
        "VIEW_AS_READ_ONLY). Returns who is previewed.",
      requestBody: { schema: { type: "object", properties: { data: object({ kind: { type: "string", enum: ["role", "user"] }, id: UUID }, ["kind", "id"]) } } },
      response: ok(object({ kind: { type: "string", enum: ["role", "user"] }, id: UUID, name: { type: "string" } }, ["kind", "id", "name"])),
    }),
  }, async (request) => {
    const { kind, id } = requestData(request.body);
    if ((kind !== "role" && kind !== "user") || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TotalBaseError("INVALID_VIEW_AS", "kind is role or user, id a uuid.");
    const target = await loadViewAsTarget(context, kind, id);
    await context.audit.record(context.database, {
      requestId: request.id,
      principal: { type: "ADMIN", id: request.admin!.id },
      action: "AUTH",
      status: "EXECUTED",
      source: "admin",
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      metadata: { event: "view_as.start", kind, target: id, name: target.name },
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    return { data: { kind, id, name: target.name } };
  });
}
