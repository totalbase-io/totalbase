/**
 * Identifies who is performing an action against TotalBase.
 * See Specification_Security.md §11.2 (audit_logs.principal_type).
 */
export type PrincipalType = "USER" | "API_KEY" | "ADMIN" | "SYSTEM";

/**
 * The authenticated actor for a request/transaction.
 * Used by @totalbase/database (context), @totalbase/permissions,
 * and @totalbase/audit.
 */
export interface Principal {
  type: PrincipalType;
  /** totalbase.users.id (USER/ADMIN) / totalbase.tokens.id (API_KEY), absent for SYSTEM */
  id: string | null;
}

export const SYSTEM_PRINCIPAL: Principal = { type: "SYSTEM", id: null };
