import type { FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import { viewAsFor } from "./view-as.js";

interface CallerRoles {
  roleIds: string[];
  administrator: boolean;
}

/**
 * Resolved once per request: a route's checks ask several times (an App DataView's readability, its actions, its
 * targets, its hidden relations), each the same answer - the caller's roles don't change within one request.
 */
const RESOLVED = new WeakMap<FastifyRequest, Promise<CallerRoles>>();

/** The App caller's effective role ids, and whether they make an Administrator (who sees every object and bypasses both access levels). */
export function callerRoles(context: AppContext, request: FastifyRequest): Promise<CallerRoles> {
  let resolved = RESOLVED.get(request);
  if (!resolved) {
    resolved = resolveCallerRoles(context, request);
    RESOLVED.set(request, resolved);
    // A failure isn't kept: the next ask tries again (and answers its own error).
    resolved.catch(() => RESOLVED.delete(request));
  }
  return resolved;
}

async function resolveCallerRoles(context: AppContext, request: FastifyRequest): Promise<CallerRoles> {
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
