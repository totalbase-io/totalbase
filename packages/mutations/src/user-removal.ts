import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { DataPrincipal } from "./context.js";
import { resolveTableGrant, rowFilterLimits, rowPassesGrant, type TableAuthorizationContext } from "./table-row-authorization.js";

/** What removing needs beyond the grant: the account's own tables, and its role assignments. */
export interface RemovalContext extends TableAuthorizationContext {
  users: {
    findById(id: string): Promise<{ id: string; email: string; name: string | null; owner: boolean } | null>;
    remove(id: string, actorId: string | undefined, client: Queryable): Promise<boolean>;
  };
  roleAssignments: {
    listRolesForUser(userId: string): Promise<string[]>;
    setRolesForUser(userId: string, roleIds: string[], client: Queryable): Promise<void>;
  };
  roles: { isAdministrator(roleIds: string[]): Promise<boolean> };
}

export interface RemovedUser {
  id: string;
  email: string;
  name: string | null;
  /** The roles the account held, by id - for the audit entry. */
  rolesRemoved: string[];
}

/**
 * Removes a user's account (Security.md §1.12): the row kept, every way in and every role taken away, in one
 * transaction made on the caller's behalf - PostgreSQL's own rules on users and users_roles (the owner, a
 * managing role's last member) apply to it as to any write. `principal` undefined: an administrator through
 * the Admin API, `actorUserId` them. Otherwise authorized like a Data API write, as sending an invitation is:
 * UPDATE on users, the row inside the grant's row filter (outside it the user doesn't exist for the caller),
 * and never an administrator's account unless the caller is one.
 */
export async function removeUser(
  context: RemovalContext,
  caller: { principal: DataPrincipal; administrator: boolean } | { actorUserId: string },
  id: string,
): Promise<RemovedUser> {
  const notFound = () => new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
  const delegated = "principal" in caller ? caller : undefined;
  const actorUserId = delegated ? delegated.principal.actorUserId : (caller as { actorUserId: string }).actorUserId;
  const grant = delegated ? await resolveTableGrant(context, delegated.principal, "users", "UPDATE", "ACTION_DENIED") : undefined;
  const limits = await rowFilterLimits(context);
  const user = await context.users.findById(id);
  if (!user) throw notFound();
  const rolesRemoved = await context.roleAssignments.listRolesForUser(id);

  await context.database.transaction(async (client) => {
    if (delegated && grant && !(await rowPassesGrant(client, context, delegated.principal, grant, id, limits))) throw notFound();
    if (delegated && !delegated.administrator && (user.owner || await context.roles.isAdministrator(rolesRemoved))) {
      throw new TotalBaseError("PERMISSION_DENIED", "An administrator's account can only be changed by an administrator.");
    }
    if (!(await context.users.remove(id, actorUserId, client))) throw notFound();
    await context.roleAssignments.setRolesForUser(id, [], client);
  }, { actorUserId });
  return { id: user.id, email: user.email, name: user.name, rolesRemoved };
}
