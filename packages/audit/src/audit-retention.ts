import type { Queryable } from "@totalbase/database";

/** Rows per DELETE: a large backlog is purged in short statements, not one long lock-holding one. */
const PURGE_BATCH_SIZE = 5_000;

/**
 * Deletes audit entries older than `retentionDays` (audit.retention_days)
 * by `created_at`, on the log's created_at index - the server's hourly
 * retention job, never inside a business transaction
 * (Specification_Security.md §11.2). 0 keeps every entry: nothing is
 * deleted. Returns how many were.
 */
export async function purgeAuditLogs(client: Queryable, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  let total = 0;
  for (;;) {
    const { rowCount } = await client.query(
      `DELETE FROM totalbase.logs
       WHERE id IN (
         SELECT id FROM totalbase.logs
         WHERE created_at < now() - make_interval(days => $1)
         LIMIT ${PURGE_BATCH_SIZE}
       )`,
      [retentionDays],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < PURGE_BATCH_SIZE) return total;
  }
}
