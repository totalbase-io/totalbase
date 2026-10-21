import type { Database } from "@totalbase/database";

/**
 * "Administrator" means one of two things, each with its one function - never an inline query:
 *
 * - **ADMIN access** (`admin_access AND active`): the full data-permission bypass. The reserved
 *   Administrators role has it, and so does the reserved Workflows role, for the system account
 *   workflows run as. Two readers of the same set:
 *   - `holdsAdminAccess` (here) - cached forever per Database instance: the flag is restricted to
 *     reserved roles by a CHECK constraint no request can edit, so the set can't change at runtime. The
 *     permission resolvers (`EffectivePermissionService.isAdministrators`,
 *     `WorkflowPermissionService`) use it on every resolve, where a query per call would be paid on every
 *     Data API request.
 *   - `RolesService.isAdministrator` - live, through `effectiveAccess`: the same flag, read again on each
 *     call, for the server's routes and guards that branch behavior (delegated administration, a token's
 *     plane) and where one query per request is the price of a role change taking effect at once.
 * - **The Administrators role** (`RolesService.holdsAdministratorsRole`): the active reserved role by
 *   that name - deliberately narrower than ADMIN access, since a system account is not an administrator.
 *   The one gate to the Admin API (`requireAdmin`, plane="ADMIN" tokens).
 *
 * The ids of the roles with ADMIN access (admin_access AND active), once
 * per Database instance: the flag is restricted to the reserved roles (a
 * CHECK constraint) no request can edit, so the set can't change at
 * runtime - the one definition the permission services share
 * (Foundations.md §4.6 on per-process state).
 */
const ADMIN_ROLE_IDS = new WeakMap<Database, Promise<Set<string>>>();

export function adminRoleIds(database: Database): Promise<Set<string>> {
  let ids = ADMIN_ROLE_IDS.get(database);
  if (!ids) {
    ids = database
      .query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE admin_access AND active`)
      .then(({ rows }) => new Set(rows.map((r) => r.id)));
    ids.catch(() => ADMIN_ROLE_IDS.delete(database));
    ADMIN_ROLE_IDS.set(database, ids);
  }
  return ids;
}

/** Whether any of these role ids grants ADMIN access - the full data-permission bypass. */
export async function holdsAdminAccess(database: Database, roleIds: string[]): Promise<boolean> {
  const ids = await adminRoleIds(database);
  return roleIds.some((id) => ids.has(id));
}
