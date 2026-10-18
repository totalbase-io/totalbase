import type { Database } from "@totalbase/database";
import { holdsAdminAccess } from "./admin-roles.js";
import type { PermissionDecision } from "./permission-resolver.js";

/**
 * The WORKFLOW_INVOKE grant (specs/Specification_Workflows.md §12): object
 * access, as a DataView's or a Dashboard's roles (Specification_Security.md
 * §7) - a role either may invoke the workflow or holds no grant; there is no
 * DENY, unlike the data permissions. Its own table rather than a row in
 * totalbase.permissions: that table's `resource` column is a
 * resources id (TABLE/VIEW/FUNCTION only) - a workflow is never
 * represented as a synthetic database resource.
 */
export class WorkflowPermissionService {

  constructor(private readonly database: Database) {}

  /** The same ADMIN-access bypass as EffectivePermissionService.isAdministrators (admin-roles.ts). */
  private isAdministrators(roleIds: string[]): Promise<boolean> {
    return holdsAdminAccess(this.database, roleIds);
  }

  /** ALLOW for an administrator or a role granted; UNDEFINED (not authorized) otherwise, the caller with no role included. */
  async resolveInvoke(roleIds: string[], workflowId: string): Promise<PermissionDecision> {
    if (roleIds.length === 0) return "UNDEFINED";
    if (await this.isAdministrators(roleIds)) return "ALLOW";
    const { rows } = await this.database.query(
      `SELECT 1 FROM totalbase.workflows_roles WHERE role = ANY($1) AND workflow = $2 LIMIT 1`,
      [roleIds, workflowId],
    );
    return rows.length > 0 ? "ALLOW" : "UNDEFINED";
  }

  /** The roles granted, oldest first. */
  async listRoles(workflowId: string): Promise<string[]> {
    const { rows } = await this.database.query<{ role: string }>(
      `SELECT role FROM totalbase.workflows_roles WHERE workflow = $1 ORDER BY created_at, role`,
      [workflowId],
    );
    return rows.map((r) => r.role);
  }

  /** Grants one role. */
  async grant(roleId: string, workflowId: string): Promise<void> {
    await this.database.query(
      `INSERT INTO totalbase.workflows_roles (role, workflow) VALUES ($1, $2) ON CONFLICT (role, workflow) DO NOTHING`,
      [roleId, workflowId],
    );
  }

  /**
   * Replaces the workflow's grant set in one transaction: the listed roles
   * get (or keep) their grant, every other loses it. An unknown role fails
   * the whole replace through its foreign key. Answers the set, deduplicated,
   * in the order given.
   */
  async setRoles(workflowId: string, roleIds: string[]): Promise<string[]> {
    const roles = [...new Set(roleIds)];
    await this.database.transaction(async (client) => {
      await client.query(
        `DELETE FROM totalbase.workflows_roles WHERE workflow = $1 AND NOT (role = ANY($2::uuid[]))`,
        [workflowId, roles],
      );
      await client.query(
        `INSERT INTO totalbase.workflows_roles (role, workflow)
         SELECT role, $1::uuid FROM unnest($2::uuid[]) AS role
         ON CONFLICT (role, workflow) DO NOTHING`,
        [workflowId, roles],
      );
    });
    return roles;
  }
}
