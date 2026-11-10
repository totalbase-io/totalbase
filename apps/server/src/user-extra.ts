import type { DataPrincipal } from "@totalbase/mutations";
import { resolveTableResource } from "@totalbase/resources";
import { isProjectUserColumn } from "@totalbase/shared";
import type { AppContext } from "./context.js";
import { readRowByKey } from "./data-read.js";
import type { ReadOrigin } from "./read-audit.js";

/**
 * The project's own columns of a user's row, as the user may read them (Security.md §2.5, §1.2): what
 * `GET /api/auth/me` and the sign-in answers carry as `user.extra`. Decided by the security engine, not by a
 * bespoke rule - one read of the user's own row through the Data API's by-key path, with the user's live roles:
 * READ on `users`, its field grants (every column the grants allow, a Password or protected column never) and
 * its row filter, which must let the user see their own row. Administrators read every column. Nothing granted,
 * or the row outside the filter: `{}` - the answer never fails for it.
 */
export async function userExtra(context: AppContext, userId: string, origin: ReadOrigin): Promise<Record<string, unknown>> {
  const columns = await context.auth.users.projectColumns();
  if (columns.length === 0) return {};
  const { rows } = await context.database.query<Record<string, unknown>>(`SELECT * FROM totalbase.users WHERE id = $1`, [userId]);
  const userRow = rows[0];
  if (!userRow) return {};
  const dataPrincipal: DataPrincipal = {
    principal: { type: "USER", id: userId },
    roleIds: await context.roleAssignments.listEffectiveRolesForUser(userId),
    userRow,
    actorUserId: userId,
  };
  try {
    const resource = await resolveTableResource(context, "totalbase", "users", "GET");
    const { row } = await readRowByKey(context, dataPrincipal, resource, userId, origin);
    return Object.fromEntries(Object.entries(row).filter(([column]) => isProjectUserColumn(column)));
  } catch {
    // No READ on users, the row outside the filter, the table unexposed: the user has nothing to read of it.
    return {};
  }
}
