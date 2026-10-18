import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { ADMIN_SCHEMAS, adminDoc, arrayOf, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";

/**
 * Bulk effective-permissions views (Specification_Admin_UI.md §11.4,
 * gap #1). Thin HTTP wrapper over EffectivePermissionService.resolveBulk() -
 * no permission logic lives here, only request shaping, matching every
 * other admin route in this directory.
 */
export function registerAdminEffectivePermissionsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.get<{ Params: { id: string } }>(
    "/admin/api/users/:id/effective-permissions",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "What a user can do on every resource",
        description: "Resolved across all of the user's effective roles, exactly as the Data API resolves them. 404 for an unknown user.",
        pathParameters: { id: UUID_PARAM },
        response: {
          status: "200",
          schema: object({ data: arrayOf(ref("EffectivePermissions")), meta: object({ roles: arrayOf(UUID) }) }, ["data"]),
        },
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      if (!(await context.auth.users.findById(request.params.id))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      const roleIds = await context.roleAssignments.listEffectiveRolesForUser(request.params.id);
      const resources = await context.resourcesAdmin.list();
      const decisions = await context.effectivePermissions.resolveBulk(roleIds, resources.map((r) => r.id));
      return {
        data: resources.map((r) => ({ resource: r.id, actions: decisions.get(r.id) })),
        meta: { roles: roleIds },
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/roles/:id/effective-permissions",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "What a role alone can do on every resource",
        pathParameters: { id: UUID_PARAM },
        response: ok(arrayOf(ref("EffectivePermissions"))),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      const role = await context.roles.findById(request.params.id);
      if (!role) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Role not found.");
      const resources = await context.resourcesAdmin.list();
      const decisions = await context.effectivePermissions.resolveBulk([request.params.id], resources.map((r) => r.id));
      return { data: resources.map((r) => ({ resource: r.id, actions: decisions.get(r.id) })) };
    },
  );
}
