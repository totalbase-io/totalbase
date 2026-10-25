import type { FastifyInstance, FastifyRequest } from "fastify";
import { managedRoleIds, type ResourceAction, type SetPermissionInput } from "@totalbase/permissions";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { parseGrant, parseRoleIdList, requireValidAction, type PermissionBody } from "./admin-permissions.js";
import { listableDataViews } from "./app-dataviews.js";

type ObjectKind = "dataviews" | "dashboards" | "workflows";

/** Each kind's grant table and its object column - the tables of Security.md §7. */
const OBJECT_TABLES: Record<ObjectKind, { table: string; column: string }> = {
  dataviews: { table: "dataviews_roles", column: "dataview" },
  dashboards: { table: "dashboards_roles", column: "dashboard" },
  workflows: { table: "workflows_roles", column: "workflow" },
};

function objectKind(value: string): ObjectKind {
  if (value === "dataviews" || value === "dashboards" || value === "workflows") return value;
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
  const { table, column } = OBJECT_TABLES[kind];
  const { rows } = await context.database.query(`SELECT 1 FROM totalbase.${table} WHERE ${column} = $1 AND role = ANY($2::uuid[])`, [id, roleIds]);
  if (rows.length === 0) throw notYours();
  if (kind === "dashboards") {
    if (!(await context.dashboardsAdmin.get(id)).delegable) {
      throw new TotalBaseError("PERMISSION_DENIED", "An administrator hasn't marked this dashboard as one managers may share.");
    }
    return;
  }
  const { definition } = await context.workflowsAdmin.getPublished(id).catch(() => { throw notYours(); });
  const operations = (definition.operations as { type: string; configuration?: Record<string, unknown> }[] | undefined) ?? [];
  const start = operations.find((op) => op.type === "totalbase.start")?.configuration ?? {};
  if (start.trigger !== "MANUAL" || start.execute_as) {
    throw new TotalBaseError("PERMISSION_DENIED", "Only a manual workflow that runs as whoever runs it can be shared by a manager.");
  }
}

/**
 * The role a delegated manager writes the grants of (Security.md §9.6): one below a role of theirs with
 * MANAGE_ROLES - never one they hold, so nobody widens their own access. An administrator writes grants through
 * the Admin API.
 */
async function managedRole(context: AppContext, request: FastifyRequest, roleId: string): Promise<{ principal: DataPrincipal; parent: string }> {
  const principal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
  if (await context.effectivePermissions.isAdministrators(principal.roleIds)) {
    throw new TotalBaseError("PERMISSION_DENIED", "An administrator writes grants through the Admin API.");
  }
  const role = await context.roles.findById(roleId);
  const scope = await managedRoleIds(context.database, principal.roleIds);
  if (!role || !scope.includes(roleId) || principal.roleIds.includes(roleId) || !role.parent) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "No role you manage has this id.");
  }
  return { principal, parent: role.parent };
}

/**
 * A delegated grant stays within its role's ceiling (Security.md §9.6): ALLOW only - a DENY would reach a
 * user's roles from other branches (§6.2) - for an action the parent may take on the resource, and fields the
 * parent may use. Its row filter and payload checks are free: the resolver AND-combines the parent's with them
 * (§6.11), live, so what is written here never reaches past the parent - this check is the clear error,
 * the resolver the guarantee.
 */
async function assertWithinCeiling(context: AppContext, parent: string, resourceId: string, action: ResourceAction, grant: SetPermissionInput): Promise<void> {
  if (grant.effect !== "ALLOW") {
    throw new TotalBaseError("PERMISSION_DENIED", "A role you manage is granted with ALLOW only.");
  }
  const ceiling = await context.effectivePermissions.resolve([parent], resourceId, action);
  const parentName = (await context.roles.findById(parent))?.name ?? "parent";
  if (ceiling.action !== "ALLOW") {
    throw new TotalBaseError("PERMISSION_EXCEEDS_CEILING", `The ${parentName} role can't ${action} on this resource, so a role under it can't either.`, {
      meta: { parent, action, fields: [] },
    });
  }
  const beyond = (grant.fields ?? []).filter((f) => f.effect === "ALLOW" && ceiling.fieldDecision(f.field) !== "ALLOW").map((f) => f.field);
  if (beyond.length > 0) {
    throw new TotalBaseError("PERMISSION_EXCEEDS_CEILING", `The ${parentName} role can't use ${beyond.join(", ")} for ${action}, so a role under it can't either.`, {
      meta: { parent, action, fields: beyond },
    });
  }
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
      const roleIds = parseRoleIdList(request.body?.data?.roleIds);
      const grant = await parseGrant(context, request.body?.data);
      let actor: string | undefined;
      for (const roleId of roleIds) {
        const { principal, parent } = await managedRole(context, request, roleId);
        await assertWithinCeiling(context, parent, request.params.resource, action, grant);
        actor = principal.actorUserId;
      }
      return { data: await context.permissions.setForRoles(roleIds, request.params.resource, action, grant, { actorUserId: actor }) };
    },
  );

  // A copy of a role you manage (Security.md §9.5) - same parent, so inside your scope; its grants and object
  // access, never its members, capabilities or managers.
  app.post<{ Params: { role: string }; Body: { data?: { name?: unknown } } }>("/app/api/roles/:role/duplicate", { preHandler }, async (request, reply) => {
    const { principal } = await managedRole(context, request, request.params.role);
    const name = request.body?.data?.name;
    if (typeof name !== "string") throw new TotalBaseError("INVALID_QUERY", "name is required.");
    reply.code(201);
    return { data: await context.roles.duplicate(request.params.role, name, { delegated: true, actorUserId: principal.actorUserId }) };
  });

  // What a role you manage may be granted (Security.md §9.6): its parent's effective ALLOW decisions - each
  // resource, the actions and the fields - the editor's choices. Anything else is past the ceiling.
  app.get<{ Params: { role: string } }>("/app/api/roles/:role/ceiling", { preHandler }, async (request) => {
    const { parent } = await managedRole(context, request, request.params.role);
    const { rows: candidates } = await context.database.query<{ id: string; schema: string; name: string; type: string }>(
      `SELECT DISTINCT r.id, r."schema", r.name, r.type FROM totalbase.permissions p JOIN totalbase.resources r ON r.id = p.resource
       WHERE p.role = $1 AND p.effect = 'ALLOW' AND r.status = 'ACTIVE' ORDER BY r."schema", r.name`,
      [parent],
    );
    const decisions = await context.effectivePermissions.resolveBulk([parent], candidates.map((r) => r.id));
    const data = candidates.flatMap((resource) => {
      const actions = Object.fromEntries(
        Object.entries(decisions.get(resource.id) ?? {})
          .filter(([, decision]) => decision.decision === "ALLOW")
          .map(([action, decision]) => [action, { fields: decision.fields ?? [] }]),
      );
      return Object.keys(actions).length > 0 ? [{ resource, actions }] : [];
    });
    return { data };
  });

  // Object access (Security.md §9.7): what a role you manage opens, among what you may share with it - each
  // with its name and whether the role already opens it.
  app.get<{ Params: { role: string } }>("/app/api/roles/:role/objects", { preHandler }, async (request) => {
    const { principal } = await managedRole(context, request, request.params.role);
    const data: Record<ObjectKind, { id: string; name: string; granted: boolean }[]> = { dataviews: [], dashboards: [], workflows: [] };
    for (const kind of Object.keys(OBJECT_TABLES) as ObjectKind[]) {
      const { table, column } = OBJECT_TABLES[kind];
      const objects = kind === "dataviews" ? "dataviews" : kind === "dashboards" ? "dashboards" : "workflows";
      const { rows } = await context.database.query<{ id: string; name: string; granted: boolean }>(
        `SELECT o.id, o.name, EXISTS (SELECT 1 FROM totalbase.${table} g WHERE g.${column} = o.id AND g.role = $1) AS granted
         FROM totalbase.${objects} o
         WHERE EXISTS (SELECT 1 FROM totalbase.${table} m WHERE m.${column} = o.id AND m.role = ANY($2::uuid[]))
         ORDER BY o.name`,
        [request.params.role, principal.roleIds],
      );
      for (const row of rows) {
        const shareable = await assertDelegableObject(context, principal.roleIds, kind, row.id).then(() => true, () => false);
        if (shareable || row.granted) data[kind].push(row);
      }
    }
    return { data };
  });

  app.put<{ Params: { role: string; kind: string; id: string } }>("/app/api/roles/:role/objects/:kind/:id", { preHandler }, async (request, reply) => {
    const kind = objectKind(request.params.kind);
    const { principal } = await managedRole(context, request, request.params.role);
    await assertDelegableObject(context, principal.roleIds, kind, request.params.id);
    const { table, column } = OBJECT_TABLES[kind];
    await context.database.query(
      `INSERT INTO totalbase.${table} (${column}, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [request.params.id, request.params.role],
    );
    reply.code(204);
  });

  app.delete<{ Params: { role: string; kind: string; id: string } }>("/app/api/roles/:role/objects/:kind/:id", { preHandler }, async (request, reply) => {
    const kind = objectKind(request.params.kind);
    await managedRole(context, request, request.params.role);
    const { table, column } = OBJECT_TABLES[kind];
    const { rowCount } = await context.database.query(`DELETE FROM totalbase.${table} WHERE ${column} = $1 AND role = $2`, [request.params.id, request.params.role]);
    if (rowCount === 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", "The role doesn't open it.");
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
