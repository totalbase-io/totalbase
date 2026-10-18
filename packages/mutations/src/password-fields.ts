import { assertPasswordStrength, hashPassword } from "@totalbase/auth";
import { getPasswordColumns } from "@totalbase/resources";
import type { PermissionDecision } from "@totalbase/permissions";
import type { MutationsContext } from "./context.js";

/**
 * Password-column support for the generic Data API (the `password` entry of
 * the column input catalog, packages/tb-catalog/src/columns/column-inputs.ts).
 * Unlike totalbase-guardrails.ts's PROTECTED_FIELDS (columns that must
 * NEVER be writable via the generic API at all - password_hash/token_hash/
 * ciphertext are only ever set through their own dedicated service code),
 * a Password column's whole point IS being writable through the generic
 * CREATE/UPDATE - it just needs its value hashed first, and the hash
 * hidden afterward. So this hooks the same two choke points every write/
 * read call site already funnels through (mutationContext.fieldDecision,
 * and the RETURNING-star / stripInternal() result) rather than reusing
 * protectedFieldDecision, which would just block writes outright.
 */

/** One fresh lookup per operation (hoisted above a bulk items/operations loop, not per-item) - same "no caching layer" convention resolveTableResource's own per-request resources lookup already follows. */
export async function loadPasswordColumns(context: Pick<MutationsContext, "database">, resourceId: string): Promise<Set<string>> {
  return getPasswordColumns(context.database, resourceId);
}

/**
 * Replaces each password-widget column present in `data` with its argon2
 * hash (same `auth.password_min_length` policy admin/user auth already
 * enforces - packages/auth/src/password.ts, admin-users.ts/auth-service.ts).
 * A non-string value (not provided, or explicitly cleared to null) is left
 * untouched - PostgreSQL's own nullability decides if that's valid. Never
 * mutates `data`.
 */
export async function hashPasswordFields(
  context: MutationsContext,
  passwordColumns: Set<string>,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (passwordColumns.size === 0) return data;
  const minLength = await context.settings.get("auth.password_min_length");
  const result = { ...data };
  for (const column of passwordColumns) {
    const value = result[column];
    if (typeof value !== "string") continue;
    assertPasswordStrength(value, minLength);
    result[column] = await hashPassword(value);
  }
  return result;
}

/**
 * The RETURNING-row counterpart - compileInsert/compileUpdate/compileDelete
 * all `RETURNING *`, and stripInternal() only ever removed __authorized/
 * __payload_check_* (never anything field-permission-related - a
 * pre-existing gap for the static PROTECTED_FIELDS list too, out of scope
 * to fix generally here), so a Password column's hash must be stripped
 * explicitly before any mutation response reaches the client.
 */
export function stripPasswordFields(row: Record<string, unknown>, passwordColumns: Set<string>): Record<string, unknown> {
  if (passwordColumns.size === 0) return row;
  const clean = { ...row };
  for (const column of passwordColumns) delete clean[column];
  return clean;
}

/** The read-projection counterpart - denies any Password column regardless of the role's own field grant, same shape as protectedFieldDecision. Chain after it, only at read call sites (write sites need ALLOW to pass through so hashPasswordFields' output can actually be written). */
export function withPasswordColumnsDenied(
  fieldDecision: (field: string) => PermissionDecision,
  passwordColumns: Set<string>,
): (field: string) => PermissionDecision {
  if (passwordColumns.size === 0) return fieldDecision;
  return (field: string) => (passwordColumns.has(field) ? "DENY" : fieldDecision(field));
}
