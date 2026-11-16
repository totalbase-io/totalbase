import type { FastifyInstance, FastifyRequest } from "fastify";
import { grantObject, isObjectKind, managedRoleIds, OBJECT_KINDS, objectsOpenedBy, opensObject, revokeObject, type ObjectKind, type ResourceAction, type SetPermissionInput } from "@totalbase/permissions";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { parseGrant, parseRoleIdList, requireValidAction, type PermissionBody } from "./admin-permissions.js";
import { listableDataViews } from "./app-dataviews.js";
import { optionalData } from "../request-body.js";

/** A path's object kind - DataViews, dashboards or workflows (Security.md §7). */
function objectKind(value: string): ObjectKind {
  if (isObjectKind(value)) return value;
  throw new TotalBaseError("RESOURCE_NOT_FOUND", `Unknown object kind: ${value}`);
}

/**
 * Whether a manager may open an object to a role they manage (Security.md §9.7) - never more than they hold:
 * a DataView they can open themselves (its object access, and READ on its source); a dashboard they can open
 * that an administrator marked delegable (its SQL bypasses the resolver, so the ceiling doesn't contain it); a
 * workflow they can invoke that runs as its caller (no `execute_as`), so the ceiling contains its record steps.
 */
async function assertDelegableObject(context: AppContext, roleIds: string[], kind: ObjectKind, id: string): Promise<void> {
  const notYours = () => new TotalBaseError("RESOURCE_NOT_FOUND", "Nothing you can open has this id.");
  if (kind === "dataviews") {
    const view = await context.dataviewsAdmin.get(id).catch(() => null);
    if (!view || (await listableDataViews(context, roleIds, [view])).length === 0) throw notYours();
    return;
  }
  if (!(await opensObject(context.database, kind, id, roleIds))) throw notYours();
  if (kind === "dashboards") {
    if (!(await context.dashboardsAdmin.get(id)).delegable) {
      throw new TotalBaseError("PERMISSION_DENIED", "An administrator hasn't marked this dashboard as one managers may share.");
    }
    return;
  }
  const { definition } = await context.workflowsAdmin.getPublished(id).catch(() => { throw notYours(); });
  if (!runsAsCaller(definition)) {
    throw new TotalBaseError("PERMISSION_DENIED", "Only a manual workflow that runs as whoever runs it can be shared by a manager.");
  }
}

/** A manual workflow with no `execute_as` - it runs as whoever runs it, so the ceiling contains its record steps. */
function runsAsCaller(definition: { operations?: unknown }): boolean {
  const operations = (definition.operations as { type: string; configuration?: Record<string, unknown> }[] | undefined) ?? [];
  const start = operations.find((op) => op.type === "totalbase.start")?.configuration ?? {};
  return start.trigger === "MANUAL" && !start.execute_as;
}

/**
 * Which of these objects - each one the caller already opens - they may share (assertDelegableObject's rule), in
 * one pass per kind instead of one check per object.
 */
async function delegableAmong(context: AppContext, roleIds: string[], kind: ObjectKind, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (kind === "dataviews") {
    const views = (await Promise.all(ids.map((id) => context.dataviewsAdmin.get(id).catch(() => null)))).filter((view) => view !== null);
    return new Set((await listableDataViews(context, roleIds, views)).map((view) => view.id));
  }
  if (kind === "dashboards") return context.dashboardsAdmin.delegableAmong(ids);
  const published = await Promise.all(ids.map((id) => context.workflowsAdmin.getPublished(id).then((p) => (runsAsCaller(p.definition) ? id : null), () => null)));
  return new Set(published.filter((id) => id !== null));
}

/**
 * The role a delegated manager writes the grants of (Security.md §9.6): one below a role of theirs with
 * MANAGE_ROLES - never one they hold, so nobody widens their own access. An administrator writes grants through
 * the Admin API.
 */
async function managedRole(context: AppContext, request: FastifyRequest, roleId: string): Promise<{ principal: DataPrincipal; parent: string }> {
  const { principal, scope } = await managerScope(context, request);
  const role = await context.roles.findById(roleId);
  if (!role || !scope.includes(roleId) || principal.roleIds.includes(roleId) || !role.parent) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "No role you manage has this id.");
  }
  return { principal, parent: role.parent };
}

/** The manager and the roles they manage - once per request, however many roles it names. */
const SCOPES = new WeakMap<FastifyRequest, Promise<{ principal: DataPrincipal; scope: string[] }>>();
function managerScope(context: AppContext, request: FastifyRequest): Promise<{ principal: DataPrincipal; scope: string[] }> {
  let resolved = SCOPES.get(request);
  if (!resolved) {
    resolved = (async () => {
      const principal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      if (await context.effectivePermissions.isAdministrators(principal.roleIds)) {
        throw new TotalBaseError("PERMISSION_DENIED", "An administrator writes grants through the Admin API.");
      }
      return { principal, scope: await managedRoleIds(context.database, principal.roleIds) };
    })();
    SCOPES.set(request, resolved);
  }
  return resolved;
}

/**
 * A delegated grant stays within its role's ceiling (Security.md §9.6): ALLOW only - a DENY would reach a
 * user's roles from other branches (§6.2) - and within the parent's own access (`beyondCeiling`, the permissions
 * package's one test), as a clear error.
 */
async function assertWithinCeiling(context: AppContext, parent: string, resourceId: string, action: ResourceAction, grant: SetPermissionInput): Promise<void> {
  if (grant.effect !== "ALLOW") {
    throw new TotalBaseError("PERMISSION_DENIED", "A role you manage is granted with ALLOW only.");
  }
  const beyond = await context.effectivePermissions.beyondCeiling(parent, resourceId, action, grant);
  if (!beyond) return;
  const parentName = (await context.roles.findById(parent))?.name ?? "parent";
  const fields = beyond.reason === "FIELDS" ? beyond.fields : [];
  const what = beyond.reason === "FIELDS" ? `use ${fields.join(", ")} for ${action}` : `${action} on this resource`;
  throw new TotalBaseError("PERMISSION_EXCEEDS_CEILING", `The ${parentName} role can't ${what}, so a role under it can't either.`, {
    meta: { parent, action, fields },
  });
}

/**
 * Delegated grants (Security.md §9.6): a holder of MANAGE_ROLES writes the grants of the roles below theirs,
 * within each one's ceiling. The bodies are the Admin API's (§5.3), parsed the same way; who granted is
 * recorded (`granted_by`).
 */
export function registerAppRolesRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  app.get<{ Params: { role: string } }>(
    "/app/api/roles/:role/permissions",
    { preHandler },
    async (request) => {
      await managedRole(context, request, request.params.role);
      return { data: await context.permissions.listForRole(request.params.role) };
    },
  );

  app.put<{ Params: { role: string; resource: string; action: string }; Body: { data?: PermissionBody } }>(
    "/app/api/roles/:role/resources/:resource/permissions/:action",
    { preHandler },
    async (request) => {
      const action = requireValidAction(request.params.action);
      const { principal, parent } = await managedRole(context, request, request.params.role);
      const grant = await parseGrant(context, request.body?.data);
      await assertWithinCeiling(context, parent, request.params.resource, action, grant);
      const permission = await context.permissions.set(request.params.role, request.params.resource, action, grant, { actorUserId: principal.actorUserId });
      return { data: permission };
    },
  );

  // One grant for several roles you manage at once, each within its own ceiling - all of them, or none.
  app.put<{ Params: { resource: string; action: string }; Body: { data?: PermissionBody & { roleIds?: unknown } } }>(
    "/app/api/resources/:resource/permissions/:action",
    { preHandler },
    async (request) => {
      const action = requireValidAction(request.params.action);
      const roleIds = parseRoleIdList(optionalData(request.body).roleIds);
      const grant = await parseGrant(context, request.body?.data);
      let actor: string | undefined;
      // Roles under one parent share its ceiling: checked once per parent.
      const parents = new Set<string>();
      for (const roleId of roleIds) {
        const { principal, parent } = await managedRole(context, request, roleId);
        actor = principal.actorUserId;
        parents.add(parent);
      }
      await Promise.all([...parents].map((parent) => assertWithinCeiling(context, parent, request.params.resource, action, grant)));
      return { data: await context.permissions.setForRoles(roleIds, request.params.resource, action, grant, { actorUserId: actor }) };
    },
  );

  // A copy of a role you manage (Security.md §9.5) - same parent, so inside your scope; its grants and object
  // access, never its members, capabilities or managers.
  app.post<{ Params: { role: string }; Body: { data?: { name?: unknown } } }>("/app/api/roles/:role/duplicate", { preHandler }, async (request, reply) => {
    const { principal } = await managedRole(context, request, request.params.role);
    const name = optionalData(request.body).name;
    if (typeof name !== "string") throw new TotalBaseError("INVALID_QUERY", "name is required.");
    reply.code(201);
    return { data: await context.roles.duplicate(request.params.role, name, { delegated: true, actorUserId: principal.actorUserId }) };
  });

  // What a role you manage may be granted (Security.md §9.6): its parent's effective ALLOW decisions - each
  // resource, the actions and the fields - the editor's choices. Anything else is past the ceiling.
  app.get<{ Params: { role: string } }>("/app/api/roles/:role/ceiling", { preHandler }, async (request) => {
    const { parent } = await managedRole(context, request, request.params.role);
    const data = await context.effectivePermissions.ceilingOf(parent);
    return { data };
  });

  // Object access (Security.md §9.7): what a role you manage opens, among what you may share with it - each
  // with its name and whether the role already opens it.
  app.get<{ Params: { role: string } }>("/app/api/roles/:role/objects", { preHandler }, async (request) => {
    const { principal } = await managedRole(context, request, request.params.role);
    const data: Record<ObjectKind, { id: string; name: string; granted: boolean }[]> = { dataviews: [], dashboards: [], workflows: [] };
    for (const kind of OBJECT_KINDS) {
      const rows = await objectsOpenedBy(context.database, kind, principal.roleIds, request.params.role);
      // Every row is one the caller opens (the EXISTS above): what's left is whether it may be shared, all at once.
      const shareable = await delegableAmong(context, principal.roleIds, kind, rows.map((row) => row.id));
      data[kind] = rows.filter((row) => shareable.has(row.id) || row.granted);
    }
    return { data };
  });

  app.put<{ Params: { role: string; kind: string; id: string } }>("/app/api/roles/:role/objects/:kind/:id", { preHandler }, async (request, reply) => {
    const kind = objectKind(request.params.kind);
    const { principal } = await managedRole(context, request, request.params.role);
    await assertDelegableObject(context, principal.roleIds, kind, request.params.id);
    await grantObject(context.database, kind, request.params.id, request.params.role);
    reply.code(204);
  });

  app.delete<{ Params: { role: string; kind: string; id: string } }>("/app/api/roles/:role/objects/:kind/:id", { preHandler }, async (request, reply) => {
    const kind = objectKind(request.params.kind);
    await managedRole(context, request, request.params.role);
    if (!(await revokeObject(context.database, kind, request.params.id, request.params.role))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "The role doesn't open it.");
    reply.code(204);
  });

  app.delete<{ Params: { role: string; resource: string; action: string } }>(
    "/app/api/roles/:role/resources/:resource/permissions/:action",
    { preHandler },
    async (request, reply) => {
      const action = requireValidAction(request.params.action);
      await managedRole(context, request, request.params.role);
      if (!(await context.permissions.delete(request.params.role, request.params.resource, action))) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "The role has no such grant.");
      }
      reply.code(204);
    },
  );
}
