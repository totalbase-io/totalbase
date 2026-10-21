import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { WORKFLOWS_ROLE_NAME, WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";

/**
 * User<->role and API Key<->role assignment.
 * See Security.md §1.5.
 */
export class RoleAssignmentsService {
  constructor(private readonly database: Database) {}

  /**
   * The Workflows role is a real privilege-escalation surface
   * (admin_access implies full data-permission bypass and full admin
   * panel login) - unlike an ordinary reserved role
   * (Administrators), which humans are meant to hold, nobody but the one
   * seeded system account may ever be assigned this one. Backed by a DB
   * trigger too as a backstop for any path that
   * doesn't go through this service - this check exists to fail fast with
   * a clean error instead of relying on that trigger's raw exception.
   */
  private async assertWorkflowsRoleAssignmentAllowed(client: Queryable, userId: string, roleId: string): Promise<void> {
    const { rows } = await client.query<{ name: string }>(`SELECT name FROM totalbase.roles WHERE id = $1`, [roleId]);
    if (rows[0]?.name !== WORKFLOWS_ROLE_NAME) return;
    const { rows: userRows } = await client.query<{ email: string | null }>(`SELECT email FROM totalbase.users WHERE id = $1`, [userId]);
    if (userRows[0]?.email !== WORKFLOWS_SYSTEM_USER_EMAIL) {
      throw new TotalBaseError("PERMISSION_DENIED", "The Workflows role is reserved for TotalBase's own system account and cannot be assigned to any other user.");
    }
  }

  /**
   * The roles that actually grant something right now: the user's
   * assignments to ACTIVE roles only - a deactivated role grants no
   * permissions and no access. Use this wherever permissions or access
   * are resolved; listRolesForUser (every assignment) is for editing them.
   */
  async listEffectiveRolesForUser(userId: string): Promise<string[]> {
    const { rows } = await this.database.query<{ role: string }>(
      `SELECT a.role FROM totalbase.users_roles a
       JOIN totalbase.roles r ON r.id = a.role
       WHERE a."user" = $1 AND r.active`,
      [userId],
    );
    return rows.map((r) => r.role);
  }

  /** Every role assigned to the user, active or not - for editing assignments. */
  async listRolesForUser(userId: string): Promise<string[]> {
    const { rows } = await this.database.query<{ role: string }>(
      `SELECT role FROM totalbase.users_roles WHERE "user" = $1`,
      [userId],
    );
    return rows.map((r) => r.role);
  }

  /**
   * Replaces the user's whole role set. Runs in its own transaction, or in
   * the caller's when `client` is given (e.g. creating a user and its
   * roles atomically). Duplicate ids collapse to one assignment.
   */
  async setRolesForUser(userId: string, roleIds: string[], client?: Queryable): Promise<void> {
    const unique = [...new Set(roleIds)];
    const apply = async (tx: Queryable) => {
      for (const roleId of unique) {
        await this.assertWorkflowsRoleAssignmentAllowed(tx, userId, roleId);
      }
      await tx.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1`, [userId]);
      for (const roleId of unique) {
        await tx.query(
          `INSERT INTO totalbase.users_roles ("user", role) VALUES ($1, $2)`,
          [userId, roleId],
        );
      }
    };
    if (client) await apply(client);
    else await this.database.transaction(apply);
  }

  async assignRoleToUser(userId: string, roleId: string): Promise<void> {
    await this.assertWorkflowsRoleAssignmentAllowed(this.database, userId, roleId);
    await this.database.query(
      `INSERT INTO totalbase.users_roles ("user", role) VALUES ($1, $2)
       ON CONFLICT ("user", role) DO NOTHING`,
      [userId, roleId],
    );
  }
}
