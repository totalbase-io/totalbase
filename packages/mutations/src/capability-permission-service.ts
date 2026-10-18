import type { Queryable } from "@totalbase/database";
import { resolveEffect, type PermissionDecision } from "@totalbase/permissions";

/** What a role may be granted beyond row operations (Specification_Security.md §5.2). */
export type Capability = "TRANSACTIONS" | "SEND_EMAIL";

/**
 * Per-role capabilities (`roles_capabilities`): TRANSACTIONS runs POST
 * /api/transactions (Specification_Data_API.md §8), SEND_EMAIL a workflow's
 * Send email step (Specification_Workflows.md §5.16). Not modeled through
 * permissions - a capability is not a resource (migration
 * 000009) - but resolved with the same resolveEffect(): any DENY wins, no
 * grant is denied.
 */
export class CapabilityPermissionService {
  constructor(private readonly database: Queryable) {}

  async resolve(roleIds: string[], capability: Capability): Promise<PermissionDecision> {
    if (roleIds.length === 0) return "UNDEFINED";
    const { rows } = await this.database.query<{ effect: "ALLOW" | "DENY" }>(
      `SELECT effect FROM totalbase.roles_capabilities WHERE role = ANY($1) AND capability = $2`,
      [roleIds, capability],
    );
    return resolveEffect(rows);
  }

  async setGrant(roleId: string, capability: Capability, effect: "ALLOW" | "DENY"): Promise<void> {
    await this.database.query(
      `INSERT INTO totalbase.roles_capabilities (role, capability, effect)
       VALUES ($1, $2, $3)
       ON CONFLICT (role, capability) DO UPDATE SET effect = EXCLUDED.effect, updated_at = now()`,
      [roleId, capability, effect],
    );
  }

  async clearGrant(roleId: string, capability: Capability): Promise<void> {
    await this.database.query(`DELETE FROM totalbase.roles_capabilities WHERE role = $1 AND capability = $2`, [roleId, capability]);
  }
}
