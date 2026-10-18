import type { FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import { viewAsFor } from "./view-as.js";

/** The App caller's effective role ids, and whether they make an Administrator (who sees every object and bypasses both access levels). */
export async function callerRoles(context: AppContext, request: FastifyRequest): Promise<{ roleIds: string[]; administrator: boolean }> {
  const own = await context.roleAssignments.listEffectiveRolesForUser(request.admin!.id);
  // See as (view-as.ts): the previewed role's or user's roles, decided like anyone's.
  const roleIds = (await viewAsFor(context, request, own))?.roleIds ?? own;
  return { roleIds, administrator: await context.roles.isAdministrator(roleIds) };
}

/** `null` = Administrator; otherwise the caller's effective role ids - the shape the object-access filters take. */
export async function callerRoleIds(context: AppContext, request: FastifyRequest): Promise<string[] | null> {
  const { roleIds, administrator } = await callerRoles(context, request);
  return administrator ? null : roleIds;
}
