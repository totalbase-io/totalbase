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

/** A Data API write's transaction context: the request timeout, plus who is writing (`totalbase.actor_user_id`). */
export async function writeTransactionContext(context: Pick<MutationsContext, "settings">, dataPrincipal: DataPrincipal): Promise<DatabaseTransactionContext> {
  return { ...(await dataApiTimeout(context, dataPrincipal)), actorUserId: dataPrincipal.actorUserId };
}
