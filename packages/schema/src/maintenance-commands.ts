import { quoteIdentifier } from "./validation.js";

/**
 * PostgreSQL maintenance commands (Specification_Administration.md §6) - only
 * the ones that take no lock blocking reads or writes. VACUUM FULL,
 * CLUSTER and REINDEX without CONCURRENTLY are deliberately absent.
 */
export type MaintenanceOperation = "VACUUM" | "ANALYZE" | "REINDEX";

export const MAINTENANCE_OPERATIONS: readonly MaintenanceOperation[] = ["VACUUM", "ANALYZE", "REINDEX"];

/**
 * The statement for `operation` on a table (or, for REINDEX, one of its
 * indexes). Names come from the catalog by OID (@totalbase/pg-catalog
 * resolveMaintenanceTarget), never from the caller, and are quoted here.
 * VACUUM and REINDEX CONCURRENTLY can't run inside a transaction block -
 * run the result on its own, outside one.
 */
export function buildMaintenanceSql(
  operation: MaintenanceOperation,
  target: { schema: string; table: string; index?: { name: string } | undefined },
): string {
  const table = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)}`;
  switch (operation) {
    case "VACUUM":
      return `VACUUM (ANALYZE) ${table}`;
    case "ANALYZE":
      return `ANALYZE ${table}`;
    case "REINDEX":
      return target.index
        ? `REINDEX INDEX CONCURRENTLY ${quoteIdentifier(target.schema)}.${quoteIdentifier(target.index.name)}`
        : `REINDEX TABLE CONCURRENTLY ${table}`;
  }
}
