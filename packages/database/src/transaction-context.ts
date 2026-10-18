import type { Principal } from "@totalbase/shared";
import type { Queryable } from "./database.js";

/**
 * Context applied to a transaction via controlled PostgreSQL GUCs.
 * See Specification.md §18 (Database execution layer). Every
 * part is optional - e.g. the Data API passes only its request timeout
 * (api.request_timeout_ms).
 */
export interface DatabaseTransactionContext {
  principal?: Principal | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  /** The real user behind the write (a session's user, a token's owner, a workflow's execute_as) - `totalbase.actor_user_id`, read by the triggers that record who created a role or folder. */
  actorUserId?: string | undefined;
  /** Overrides the default statement_timeout for this transaction only. */
  statementTimeoutMs?: number | undefined;
  /**
   * The viewer's effective time zone (their profile's, else the instance's,
   * else their browser's) - the transaction's `TimeZone`, so PostgreSQL cuts
   * days where the viewer sees them: `$PERIOD.*`, `date_trunc`, a
   * timestamptz cast to a date. Must be a zone PostgreSQL knows.
   */
  timezone?: string | undefined;
  /**
   * The transaction's `application_name` - how a background execution's
   * backend is found in pg_stat_activity to cancel it
   * (Specification_Data_API.md §10.5).
   */
  applicationName?: string | undefined;
  /**
   * Runs right before COMMIT, inside the transaction: throwing rolls the
   * whole transaction back. A cancellable execution checks there whether
   * its caller cancelled it while it ran between statements, where
   * pg_cancel_backend has nothing to interrupt.
   */
  beforeCommit?: ((client: Queryable) => Promise<void>) | undefined;
}
