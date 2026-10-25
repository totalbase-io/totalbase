import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, created, object, UUID_PARAM, ok } from "../openapi-admin-docs.js";
import { TotalBaseError } from "@totalbase/errors";

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

  // A copy of a role (Security.md §9.5) - the starting point for the same role in another site.
  app.post<{ Params: { id: string }; Body: { data?: { name?: unknown } } }>(
    "/admin/api/roles/:id/duplicate",
    {
      preHandler,
      ...adminDoc("roles", {
        summary: "Duplicate a role",
        description:
          "A new role named `name` with the role's description, look, access flags, App home, parent, grants, object access, " +
          "capabilities and managers - never its members. A reserved role isn't copied (404). A duplicate name is 409.",
        pathParameters: { id: UUID_PARAM },
        requestBody: { schema: dataEnvelope(object({ name: { type: "string", maxLength: 64 } }, ["name"])) },
        response: created(object({ id: { type: "string", format: "uuid" }, name: { type: "string" } })),
      }),
    },
    async (request, reply) => {
      const name = request.body?.data?.name;
      if (typeof name !== "string") throw new TotalBaseError("INVALID_QUERY", "name is required.");
      reply.code(201);
      return { data: await context.roles.duplicate(request.params.id, name, { delegated: false }) };
    },
  );

  // Incompatible roles (Security.md §1.9): pairs no user may hold together - whoever operates doesn't audit.
  app.get<{ Params: { id: string } }>(
    "/admin/api/roles/:id/incompatible",
    {
      preHandler,
      ...adminDoc("roles", {
        summary: "The roles a role can't be held with",
        pathParameters: { id: UUID_PARAM },
        response: ok(arrayOf({ type: "string", format: "uuid" })),
      }),
    },
    async (request) => ({ data: await context.roles.listIncompatible(request.params.id) }),
  );

  app.put<{ Params: { id: string }; Body: { data?: { roleIds?: string[] } } }>(
    "/admin/api/roles/:id/incompatible",
    {
      preHandler,
      ...adminDoc("roles", {
        summary: "Set the roles a role can't be held with",
        description:
          "Replaces the set atomically. A pair some user already holds is refused (422, the number of such users in the " +
          "message): remove one of the two roles first. From then on, assigning either role to someone holding the other is refused.",
        pathParameters: { id: UUID_PARAM },
        requestBody: { schema: dataEnvelope(object({ roleIds: arrayOf({ type: "string", format: "uuid" }) }, ["roleIds"])) },
        response: ok(arrayOf({ type: "string", format: "uuid" })),
      }),
    },
    async (request) => ({ data: await context.roles.setIncompatible(request.params.id, request.body?.data?.roleIds ?? []) }),
  );
}
