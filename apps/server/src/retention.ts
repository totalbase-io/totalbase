import { randomUUID } from "node:crypto";
import { purgeAuditLogs } from "@totalbase/audit";
import { purgeFinishedExecutions } from "@totalbase/executions";
import { purgeProcessedOutboxEvents, releaseExpiredOutboxLeases, requeueFailedOutboxEvents } from "@totalbase/outbox";
import { SYSTEM_PRINCIPAL } from "@totalbase/shared";
import { purgeEndedTokens } from "@totalbase/users-apis";
import type { AppContext } from "./context.js";

export interface RetentionResult {
  auditLogs: number;
  idempotencyKeys: number;
  outboxEvents: number;
  executions: number;
  tokens: number;
  challenges: number;
  derivatives: { expired: number; orphanedFiles: number };
  expiredAssignments: number;
  dormantAccounts: number;
}

type RetentionContext = Pick<AppContext, "database" | "settings" | "audit" | "idempotency" | "filesTransform" | "logger" | "auth" | "roleAssignments">;

/**
 * The hourly retention job (index.ts): every purge whose window is a
 * setting, each on its own - one failing never stops the others, and none
 * runs inside a business transaction.
 *
 * - audit.retention_days: audit entries older than the window (0 keeps
 *   them all); a purge that deleted something is itself audited
 *   (AUDIT_PURGE, as the system), like the SQL Console's history purge;
 * - expired Idempotency-Key records (idempotency.ttl_hours);
 * - processed outbox events older than outbox.retention_days;
 * - finished executions (COMPLETED, FAILED, CANCELLED) older than
 *   async_executions.retention_days;
 * - ended personal access tokens (revoked or expired) older than
 *   api_keys.purge_after_days;
 * - MFA sign-in challenges used or expired a day ago (Security.md §2.17);
 * - image derivatives older than files.transforms.cache_ttl_seconds, and
 *   those of deleted files;
 * - role assignments past their expiry (Security.md §1.10), and the
 *   accounts unused for auth.dormant_account_days, deactivated (§1.11) -
 *   both audited, as the system.
 */
export async function runRetention(context: RetentionContext): Promise<RetentionResult> {
  const result: RetentionResult = { auditLogs: 0, idempotencyKeys: 0, outboxEvents: 0, executions: 0, tokens: 0, challenges: 0, derivatives: { expired: 0, orphanedFiles: 0 }, expiredAssignments: 0, dormantAccounts: 0 };
  const { logger } = context;

  try {
    const retentionDays = await context.settings.get("audit.retention_days");
    const startedAt = new Date();
    result.auditLogs = await purgeAuditLogs(context.database, retentionDays);
    if (result.auditLogs > 0) {
      await context.audit.record(context.database, {
        requestId: randomUUID(),
        principal: SYSTEM_PRINCIPAL,
        action: "AUDIT_PURGE",
        status: "EXECUTED",
        source: "system",
        metadata: { deletedCount: result.auditLogs, retentionDays },
        startedAt,
        finishedAt: new Date(),
      });
      logger.info({ deletedCount: result.auditLogs, retentionDays }, "audit log purged");
    }
  } catch (error) {
    logger.error({ error }, "audit log purge failed");
  }

  try {
    result.idempotencyKeys = await context.idempotency.purgeExpired();
    if (result.idempotencyKeys > 0) logger.info({ deletedCount: result.idempotencyKeys }, "expired idempotency keys purged");
  } catch (error) {
    logger.error({ error }, "idempotency key purge failed");
  }

  try {
    const retentionDays = await context.settings.get("outbox.retention_days");
    result.outboxEvents = await purgeProcessedOutboxEvents(context.database, retentionDays);
    if (result.outboxEvents > 0) logger.info({ deletedCount: result.outboxEvents, retentionDays }, "processed outbox events purged");
  } catch (error) {
    logger.error({ error }, "outbox purge failed");
  }

  try {
    const retentionDays = await context.settings.get("async_executions.retention_days");
    result.executions = await purgeFinishedExecutions(context.database, retentionDays);
    if (result.executions > 0) logger.info({ deletedCount: result.executions, retentionDays }, "finished executions purged");
  } catch (error) {
    logger.error({ error }, "executions purge failed");
  }

  try {
    const purgeAfterDays = await context.settings.get("api_keys.purge_after_days");
    result.tokens = await purgeEndedTokens(context.database, purgeAfterDays);
    if (result.tokens > 0) logger.info({ deletedCount: result.tokens, purgeAfterDays }, "ended tokens purged");
  } catch (error) {
    logger.error({ error }, "tokens purge failed");
  }

  try {
    result.challenges = await context.auth.mfa.purgeChallenges();
  } catch (error) {
    logger.error({ error }, "MFA challenges purge failed");
  }

  try {
    result.derivatives = await context.filesTransform.purgeDerivatives(context.database);
    if (result.derivatives.expired + result.derivatives.orphanedFiles > 0) logger.info(result.derivatives, "image derivatives purged");
  } catch (error) {
    logger.error({ error }, "image derivative purge failed");
  }

  // Access governance (Security.md §1.10, §1.11): what lapsed, recorded as the system's own access events.
  const recordAccess = (event: string, metadata: Record<string, unknown>) =>
    context.audit.record(context.database, {
      requestId: randomUUID(),
      principal: SYSTEM_PRINCIPAL,
      action: "AUTH",
      status: "EXECUTED",
      source: "system",
      metadata: { event, ...metadata },
      startedAt: new Date(),
      finishedAt: new Date(),
    });

  try {
    result.expiredAssignments = await context.roleAssignments.purgeExpired();
    if (result.expiredAssignments > 0) {
      await recordAccess("assignment.expired", { deletedCount: result.expiredAssignments });
      logger.info({ deletedCount: result.expiredAssignments }, "expired role assignments removed");
    }
  } catch (error) {
    logger.error({ error }, "expired role assignments purge failed");
  }

  try {
    const days = await context.settings.get("auth.dormant_account_days");
    const deactivated = await context.auth.users.deactivateDormant(days);
    result.dormantAccounts = deactivated.length;
    if (deactivated.length > 0) {
      await recordAccess("user.dormant_deactivated", { userIds: deactivated, dormantDays: days });
      logger.info({ count: deactivated.length, days }, "dormant accounts deactivated");
    }
  } catch (error) {
    logger.error({ error }, "dormant accounts deactivation failed");
  }

  return result;
}

/**
 * The outbox's retry step, run by the fallback poller before it looks
 * for PENDING events: PROCESSING events whose lease expired (their
 * process stopped mid-dispatch) become FAILED attempts, then FAILED events
 * with attempts left whose backoff has elapsed go back to PENDING
 * (outbox.max_attempts, outbox.retry_delay_seconds - Data_API.md §13.3).
 */
export async function requeueFailedOutbox(context: Pick<AppContext, "database" | "settings">): Promise<string[]> {
  const [maxAttempts, retryDelaySeconds] = await Promise.all([
    context.settings.get("outbox.max_attempts"),
    context.settings.get("outbox.retry_delay_seconds"),
  ]);
  await releaseExpiredOutboxLeases(context.database);
  return requeueFailedOutboxEvents(context.database, { maxAttempts, retryDelaySeconds });
}
