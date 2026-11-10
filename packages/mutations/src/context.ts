import type { AuditExclusionsService, AuditService } from "@totalbase/audit";
import type { Database, DatabaseTransactionContext } from "@totalbase/database";
import type { EffectivePermissionService } from "@totalbase/permissions";
import type { SettingsService } from "@totalbase/settings";
import type { Principal } from "@totalbase/shared";
import type { CapabilityPermissionService } from "./capability-permission-service.js";

/**
 * What a Data API write needs from the running instance - the narrow
 * slice of apps/server's AppContext this package uses (AppContext
 * satisfies it structurally, so callers pass their context as is).
 */
export interface MutationsContext {
  database: Database;
  settings: Pick<SettingsService, "get">;
  audit: Pick<AuditService, "record" | "recordMany">;
  auditExclusions: Pick<AuditExclusionsService, "excludedFields">;
  effectivePermissions: Pick<EffectivePermissionService, "resolve" | "isAdministrators">;
  capabilityPermissions: Pick<CapabilityPermissionService, "resolve">;
  /** Fire-and-forget: admits DATA_EVENT-triggered workflow runs for one committed outbox event. */
  dispatchWorkflowDataEvent: (outboxEventId: string) => void;
}

/** Who a Data API request acts as - resolved by apps/server from a session, a token or a workflow's execute_as. */
export interface DataPrincipal {
  principal: Principal;
  roleIds: string[];
  /** The real user's users row - a session's user, a token's owner, a workflow's execute_as; resolves $USER.* variables. */
  userRow: Record<string, unknown> | undefined;
  /** The real user behind the call - a session's user, a token's owner, a workflow's execute_as. Recorded as a role's or folder's creator, and what delegated role ownership is checked against. */
  actorUserId?: string | undefined;
  /** The caller's effective time zone - its transactions' `TimeZone` (DatabaseTransactionContext.timezone). Unset: PostgreSQL's own. */
  timezone?: string | undefined;
  /** The user the request is made for (X-TotalBase-On-Behalf-Of, Security.md §10.3): recorded in every audit entry and outbox event and handed to triggers; it lends no permission - the request is the caller's. */
  onBehalfOf?: string | undefined;
}

/**
 * api.request_timeout_ms as a transaction context: every Data API
 * statement runs inside a transaction with this statement_timeout, so
 * PostgreSQL itself cancels a request that runs too long (QUERY_CANCELED,
 * 503). Per request rather than on the pool - schema DDL, workers and the
 * SQL Console run on the same pool and must not inherit it.
 */
export async function dataApiTimeout(context: Pick<MutationsContext, "settings">, dataPrincipal?: DataPrincipal): Promise<DatabaseTransactionContext> {
  return { statementTimeoutMs: await context.settings.get("api.request_timeout_ms"), timezone: dataPrincipal?.timezone };
}

/**
 * A Data API transaction's context - a read's or a write's, since every operation TotalBase runs for a principal
 * tells PostgreSQL who it is (Security.md §10.3): the request timeout and the caller's time zone, the real user as
 * `totalbase.actor_user_id` (a session's user, a token's owner, a workflow's executor) and the principal as
 * `totalbase.user_id` / `totalbase.principal_type`. A Row Level Security policy keys on the actor in a read as in a
 * write; it is unset where TotalBase itself acts (the Admin API's composed reads, the SQL Console, workers).
 */
export async function dataApiTransactionContext(context: Pick<MutationsContext, "settings">, dataPrincipal: DataPrincipal): Promise<DatabaseTransactionContext> {
  return { ...(await dataApiTimeout(context, dataPrincipal)), actorUserId: dataPrincipal.actorUserId, principal: dataPrincipal.principal, onBehalfOfUserId: dataPrincipal.onBehalfOf };
}

/** A Data API write's transaction context - the same as a read's (`dataApiTransactionContext`); the name says which side calls it. */
export const writeTransactionContext = dataApiTransactionContext;
