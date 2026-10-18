import type { ResolvedResource } from "@totalbase/query-engine";
import type { DataPrincipal, MutationsContext } from "./context.js";
import { withPasswordColumnsDenied } from "./password-fields.js";
import { protectedFieldDecision } from "./totalbase-guardrails.js";

export type RowProjection = (row: Record<string, unknown>) => Record<string, unknown>;

/**
 * What a mutation may hand back to its caller. Every write is `RETURNING *`,
 * and that full row is still what audit/outbox record - but the caller only
 * sees what a GET would show them: the principal's READ field grant, with
 * the same always-on floor (protected columns, Password columns) every read
 * call site applies. Without a READ grant, only the primary key comes back,
 * so the caller can still address the row it just wrote.
 *
 * Resolve once per resource per operation (not per row), like
 * loadPasswordColumns.
 */
export async function mutationResponseProjection(
  context: MutationsContext,
  dataPrincipal: DataPrincipal,
  root: ResolvedResource,
  resourceId: string,
  passwordColumns: Set<string>,
): Promise<RowProjection> {
  const read = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resourceId, "READ");
  const visible =
    read.action === "ALLOW"
      ? withPasswordColumnsDenied(protectedFieldDecision(root, read.fieldDecision), passwordColumns)
      : (field: string) => (root.primaryKey.includes(field) ? "ALLOW" : "DENY");
  return (row) => Object.fromEntries(Object.entries(row).filter(([field]) => visible(field) === "ALLOW"));
}
