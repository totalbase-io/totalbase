import type { Queryable } from "@totalbase/database";

/** Rows per DELETE: a large backlog is purged in short statements, not one long lock-holding one. */
const PURGE_BATCH_SIZE = 5_000;

/**
 * Deletes finished executions - COMPLETED, FAILED or CANCELLED - older than
 * `retentionDays` (async_executions.retention_days), by when they ended
 * (`completed_at`; a cancellation from PENDING never started, so its
 * creation counts) - the server's hourly retention job
 * (Data_API.md §10.1). PENDING and RUNNING rows are never
 * purged. 0 keeps every execution. Returns how many were deleted.
 */
export async function purgeFinishedExecutions(client: Queryable, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  let total = 0;
  for (;;) {
    const { rowCount } = await client.query(
      `DELETE FROM totalbase.executions
       WHERE id IN (
         SELECT id FROM totalbase.executions
         WHERE status IN ('COMPLETED', 'FAILED', 'CANCELLED')
           AND coalesce(completed_at, created_at) < now() - make_interval(days => $1)
         LIMIT ${PURGE_BATCH_SIZE}
       )`,
      [retentionDays],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < PURGE_BATCH_SIZE) return total;
  }
}
