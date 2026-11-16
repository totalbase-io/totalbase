import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { DataPrincipal } from "./context.js";
import { assertColumnsGranted, resolveTableGrant, rowFilterLimits, rowPassesGrant, type TableAuthorizationContext } from "./table-row-authorization.js";
import { assertRolesAssignable } from "./totalbase-guardrails.js";

const DENIED = "ACTION_DENIED";

/** What inviting needs beyond the grants: making the account and giving it roles, in the caller's transaction. */
export interface InvitationContext extends TableAuthorizationContext {
  users: { create(input: { email: string | null; name: string | null; extra: Record<string, unknown> }, client: Queryable): Promise<{ id: string; email: string | null; name: string | null }> };
  roleAssignments: { setRolesForUser(userId: string, roleIds: string[], client: Queryable): Promise<void> };
}

export interface InviteUserInput {
  email: string | null;
  name: string | null;
  roles: string[];
  /** The columns the project added to the users table - in the row's own INSERT, so a row filter or a trigger reads them. */
  extra: Record<string, unknown>;
}

/**
 * The account an invitation creates (Security.md §9.3), authorized like a Data API write: CREATE on users with
 * each column set and the row filter checked on the new row; its roles with CREATE on users_roles, each one the
 * caller may assign (the Data API's own guardrails) and each assignment passing that grant's row filter - all in
 * one transaction, made on the caller's behalf. Sending the invitation is the caller's, once it commits.
 */
export async function inviteUser(context: InvitationContext, principal: DataPrincipal, administrator: boolean, input: InviteUserInput) {
  const userGrant = await resolveTableGrant(context, principal, "users", "CREATE", DENIED);
  assertColumnsGranted(userGrant, [...(input.name ? ["email", "name"] : ["email"]), ...Object.keys(input.extra)], DENIED);
  const assignmentGrant = input.roles.length > 0 ? await resolveTableGrant(context, principal, "users_roles", "CREATE", DENIED) : undefined;
  if (assignmentGrant) assertColumnsGranted(assignmentGrant, ["user", "role"], DENIED);
  const limits = await rowFilterLimits(context);

  return context.database.transaction(async (client) => {
    const created = await context.users.create({ email: input.email, name: input.name, extra: input.extra }, client);
    if (!(await rowPassesGrant(client, context, principal, userGrant, created.id, limits))) {
      throw new TotalBaseError(DENIED, "The user does not satisfy your permission's row filter.");
    }
    if (assignmentGrant) {
      // Never a reserved or administrative role, and for a non-administrator only a role they created or one their roles manage.
      await assertRolesAssignable(client, input.roles, { administrator, actorUserId: principal.actorUserId, roleIds: principal.roleIds });
      await context.roleAssignments.setRolesForUser(created.id, input.roles, client);
      const { rows: assignments } = await client.query<{ id: string }>(`SELECT id FROM totalbase.users_roles WHERE "user" = $1`, [created.id]);
      for (const assignment of assignments) {
        if (!(await rowPassesGrant(client, context, principal, assignmentGrant, assignment.id, limits))) {
          throw new TotalBaseError(DENIED, "A role assignment does not satisfy your permission's row filter.");
        }
      }
    }
    return created;
  }, { actorUserId: principal.actorUserId });
}
