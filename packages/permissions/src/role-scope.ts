import type { Queryable } from "@totalbase/database";

/**
 * The roles a caller holding `roleIds` manages (Security.md §9.5): every role below one of their roles with the
 * MANAGE_ROLES capability - ALLOW on that role, and no DENY of it on any of theirs (§5.2) - the managing roles
 * themselves never included, so nobody manages a role they hold through it. A subquery over the bind parameter
 * `param` (a uuid[] of the caller's active roles), for the guardrails' and routes' own queries: PostgreSQL
 * walks the tree, at most four levels (`roles_parent_valid`).
 *
 * `withManagers`: the managing roles too - where a new role may be placed (its parent): directly under one's own
 * managing role, or anywhere below it.
 */
export function rolesManagedBySql(param: string, options: { withManagers?: boolean } = {}): string {
  return `(WITH RECURSIVE managers AS (
      SELECT c.role FROM totalbase.roles_capabilities c
      WHERE c.role = ANY(${param}::uuid[]) AND c.capability = 'MANAGE_ROLES' AND c.effect = 'ALLOW'
        AND NOT EXISTS (
          SELECT 1 FROM totalbase.roles_capabilities d
          WHERE d.role = ANY(${param}::uuid[]) AND d.capability = 'MANAGE_ROLES' AND d.effect = 'DENY'
        )
    ), below AS (
      SELECT r.id FROM totalbase.roles r JOIN managers m ON r.parent = m.role
      UNION
      SELECT r.id FROM totalbase.roles r JOIN below b ON r.parent = b.id
    )
    SELECT id FROM below${options.withManagers ? " UNION SELECT role FROM managers" : ""})`;
}

/** The ids of the roles a caller holding `roleIds` manages - rolesManagedBySql's, read once. */
export async function managedRoleIds(database: Queryable, roleIds: string[], options: { withManagers?: boolean } = {}): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const { rows } = await database.query<{ id: string }>(`SELECT id FROM ${rolesManagedBySql("$1", options)} scope`, [roleIds]);
  return rows.map((row) => row.id);
}
