import type { Queryable } from "@totalbase/database";

export interface OutboxStats {
  pending: number;
  /** Events the consumer gave up on - their DATA_EVENT workflows never ran. */
  failed: number;
  /** Age of the oldest event still waiting, or null when none is. */
  oldestPendingSeconds: number | null;
}

/** The queue at a glance (the admin dashboard): one scan of the (status, available_at) index. */
export async function getOutboxStats(client: Queryable): Promise<OutboxStats> {
  const { rows } = await client.query<{ pending: number; failed: number; oldest: string | null }>(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'PENDING'))::text AS oldest
     FROM totalbase.outbox
     WHERE status IN ('PENDING', 'FAILED')`,
  );
  const row = rows[0]!;
  return { pending: row.pending, failed: row.failed, oldestPendingSeconds: row.oldest === null ? null : Number(row.oldest) };
}
