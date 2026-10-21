/**
 * Pure DENY > ALLOW > UNDEFINED resolution. See Security.md §6.2
 * (action precedence) and §6.4 (field precedence).
 *
 * This is deliberately decoupled from HTTP/query-engine concerns so it
 * can be reused for action permissions, field permissions, and (once the
 * Data API lands in Phase 3) combined with row filters.
 */
export type PermissionEffect = "ALLOW" | "DENY";
export type PermissionDecision = "ALLOW" | "DENY" | "UNDEFINED";

export interface PermissionGrant {
  effect: PermissionEffect;
}

/**
 * Resolves the effective decision across every role a principal holds:
 * any DENY wins; otherwise any ALLOW wins; otherwise UNDEFINED (denied).
 */
export function resolveEffect(grants: readonly PermissionGrant[]): PermissionDecision {
  let sawAllow = false;
  for (const grant of grants) {
    if (grant.effect === "DENY") return "DENY";
    if (grant.effect === "ALLOW") sawAllow = true;
  }
  return sawAllow ? "ALLOW" : "UNDEFINED";
}

/** UNDEFINED = not allowed (Foundations.md §2.4). */
export function isAuthorized(decision: PermissionDecision): boolean {
  return decision === "ALLOW";
}
