import type { Queryable } from "@totalbase/database";

export interface OutboxRetryPolicy {
  /** outbox.max_attempts: dispatches an event gets in all, the first one included. */
  maxAttempts: number;
  /** outbox.retry_delay_seconds: the wait after the first failed attempt, doubled after each further one. */
  retryDelaySeconds: number;
}

/**
 * Puts FAILED events that still have attempts left back to PENDING once
 * their backoff has elapsed (Specification_Data_API.md §13.3) - the
 * fallback poller then dispatches them like any other pending event,
 * through the same atomic PENDING -> PROCESSING claim. The backoff is
 * counted from the failed attempt's claim (`locked_at`):
 * retry_delay_seconds x 2^(attempts - 1), the exponent capped at 16 so a
 * large max_attempts can't overflow an interval. An event that used up
 * its attempts stays FAILED - the admin dashboard counts it.
 */
export async function requeueFailedOutboxEvents(client: Queryable, policy: OutboxRetryPolicy): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE totalbase.outbox
     SET status = 'PENDING', available_at = now(), locked_at = NULL, locked_by = NULL, locked_until = NULL
     WHERE status = 'FAILED' AND attempts < $1
       AND coalesce(locked_at, created_at)
           + make_interval(secs => $2::double precision * power(2, least(greatest(attempts - 1, 0), 16))) <= now()
     RETURNING id`,
    [policy.maxAttempts, policy.retryDelaySeconds],
  );
  return rows.map((row) => row.id);
}

/**
 * Turns PROCESSING events whose dispatcher lease (`locked_until`) has
 * expired into FAILED attempts (Specification_Data_API.md §13.3): their
 * process stopped mid-dispatch - a crash, a restart - and nothing else
 * would ever finish them. The attempt was already counted when the event
 * was claimed, so `requeueFailedOutboxEvents` then retries it with the
 * usual backoff, or leaves it FAILED once it used its attempts. A retry
 * never admits a workflow twice: admissions are claimed per event
 * (`outbox_admissions`). Run by the fallback poller before the
 * retry step.
 */
export async function releaseExpiredOutboxLeases(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE totalbase.outbox
     SET status = 'FAILED', locked_until = NULL,
         last_error = 'The dispatch was abandoned (its lease expired before it finished).'
     WHERE status = 'PROCESSING' AND locked_until < now()
     RETURNING id`,
  );
  return rows.map((row) => row.id);
}

/**
 * Deletes PROCESSED events older than `retentionDays` (outbox.retention_days)
 * - the server's hourly retention job. PENDING, PROCESSING and FAILED
 * events are never purged here. Their admission claims
 * (`outbox_admissions`) go with them (ON DELETE CASCADE).
 */
export async function purgeProcessedOutboxEvents(client: Queryable, retentionDays: number): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM totalbase.outbox
     WHERE status = 'PROCESSED' AND processed_at < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return rowCount ?? 0;
}
