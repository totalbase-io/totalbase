import type { Database, Queryable } from "@totalbase/database";

/**
 * User<->role and API Key<->role assignment.
 * See Security.md §1.5.
 */
export class RoleAssignmentsService {
  constructor(private readonly database: Database) {}

  // The Workflows role is a real privilege-escalation surface (admin_access implies full data-permission bypass and
  // full admin panel login): nobody but the one seeded system account may hold it. PostgreSQL decides, on every path -
  // the trigger protect_workflows_role_assignment refuses any other assignment with insufficient_privilege (a 403).

  /**
   * The roles that actually grant something right now: the user's
   * assignments to ACTIVE roles only - a deactivated role grants no
   * permissions and no access - and not past their expiry (Security.md
   * §1.10). Use this wherever permissions or access are resolved;
   * listRolesForUser (every assignment) is for editing them.
   */
  async listEffectiveRolesForUser(userId: string): Promise<string[]> {
    const { rows } = await this.database.query<{ role: string }>(
      `SELECT a.role FROM totalbase.users_roles a
       JOIN totalbase.roles r ON r.id = a.role
       WHERE a."user" = $1 AND r.active AND (a.expires_at IS NULL OR a.expires_at > now())`,
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
   * roles atomically). Duplicate ids collapse to one assignment. A role
   * kept keeps its assignment - and its expiry (Security.md §1.10).
   */
  async setRolesForUser(userId: string, roleIds: string[], client?: Queryable): Promise<void> {
    const unique = [...new Set(roleIds)];
    const apply = async (tx: Queryable) => {
      await tx.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role <> ALL($2::uuid[])`, [userId, unique]);
      // One statement for the whole set; a kept assignment keeps its row (and its expiry).
      await tx.query(
        `INSERT INTO totalbase.users_roles ("user", role) SELECT $1, role FROM unnest($2::uuid[]) AS role ON CONFLICT ("user", role) DO NOTHING`,
        [userId, unique],
      );
    };
    if (client) await apply(client);
    else await this.database.transaction(apply);
  }

  async assignRoleToUser(userId: string, roleId: string): Promise<void> {
    await this.database.query(
      `INSERT INTO totalbase.users_roles ("user", role) VALUES ($1, $2)
       ON CONFLICT ("user", role) DO NOTHING`,
      [userId, roleId],
    );
  }

  /** When the user's assignment to the role ends (Security.md §1.10); null = until removed. False when there is no such assignment. */
  async setExpiry(userId: string, roleId: string, expiresAt: Date | null): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE totalbase.users_roles SET expires_at = $3 WHERE "user" = $1 AND role = $2`,
      [userId, roleId, expiresAt],
    );
    return rowCount > 0;
  }

  /** Removes the assignments past their expiry - the hourly job's (Security.md §1.10). Returns how many. */
  async purgeExpired(): Promise<number> {
    const { rowCount } = await this.database.query(`DELETE FROM totalbase.users_roles WHERE expires_at <= now()`);
    return rowCount;
  }
}
