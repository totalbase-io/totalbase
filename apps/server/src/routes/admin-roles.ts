import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, object, ok, UUID_PARAM } from "../openapi-admin-docs.js";

/**
 * Roles are Data API rows (roles - Security.md §10):
 * listed, read, created, edited and deleted there, an
 * administrator also setting their access flags. What is not a row
 * operation stays here: replacing a role's managers as a set.
 */
export function registerAdminRolesRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  // Role managers (Security.md §9.4): which roles' members
  // may assign this one - the only way delegated users get to hand out a
  // role they didn't create.
  app.put<{ Params: { id: string }; Body: { data?: { roleIds?: string[] } } }>(
    "/admin/api/roles/:id/managers",
    {
      preHandler,
      ...adminDoc("roles", {
        summary: "Set a role's managers",
        description: "Replaces the roles whose members may assign this role. A role with admin access is assigned by administrators only.",
        pathParameters: { id: UUID_PARAM },
        requestBody: { schema: dataEnvelope(object({ roleIds: arrayOf({ type: "string", format: "uuid" }) }, ["roleIds"])) },
        response: ok(arrayOf({ type: "string", format: "uuid" })),
      }),
    },
    async (request) => ({ data: await context.roles.setManagers(request.params.id, request.body?.data?.roleIds ?? []) }),
  );
}
