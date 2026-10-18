import type { Queryable } from "@totalbase/database";

/** Rows per DELETE: a large backlog is purged in short statements, not one long lock-holding one. */
const PURGE_BATCH_SIZE = 5_000;

/**
 * Deletes personal access tokens that ended - revoked, or past their expiry -
 * more than `purgeAfterDays` ago (api_keys.purge_after_days): the server's
 * hourly retention job (Specification_Security.md §3). An ended token stays
 * listed (Tokens → Revoked / Expired) for that long and is then deleted; a
 * token that is merely deactivated (`active = false`) is kept - it can be
 * turned on again. 0 keeps ended tokens forever. Returns how many were deleted.
 */
export async function purgeEndedTokens(client: Queryable, purgeAfterDays: number): Promise<number> {
  if (purgeAfterDays <= 0) return 0;
  let total = 0;
  for (;;) {
    const { rowCount } = await client.query(
      `DELETE FROM totalbase.tokens
       WHERE id IN (
         SELECT id FROM totalbase.tokens
         WHERE least(revoked_at, expires_at) < now() - make_interval(days => $1)
         LIMIT ${PURGE_BATCH_SIZE}
       )`,
      [purgeAfterDays],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < PURGE_BATCH_SIZE) return total;
  }
}
