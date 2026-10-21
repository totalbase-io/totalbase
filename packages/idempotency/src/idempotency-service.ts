import { createHash } from "node:crypto";
import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";

export type IdempotencyPrincipalType = "USER" | "API_KEY";

export interface IdempotencyScope {
  principalType: IdempotencyPrincipalType;
  principal: string;
  /** Identifies the operation, not the full URL - e.g. "table:public.invoices:create". */
  operationScope: string;
  key: string;
}

/** Deterministic hash over method + scope + normalized body (Data_API.md §9). */
export function computeRequestHash(method: string, operationScope: string, body: unknown): string {
  const normalized = JSON.stringify(body ?? null);
  return createHash("sha256").update(`${method}\n${operationScope}\n${normalized}`).digest("hex");
}

export interface RecordedResponse {
  status: number;
  body: unknown;
}

/**
 * Idempotency Keys (Data_API.md §9). Only
 * successful (2xx) responses are memoized: a failed attempt did not
 * durably change anything, so the record is deleted on failure and the
 * client is free to retry with the same key without hitting a stale
 * error forever (a deliberate simplification over replaying arbitrary
 * error bodies verbatim).
 *
 * The UNIQUE (principal_type, principal, operation_scope, key) index in
 * the table's UNIQUE is the actual concurrency authority
 * (Data_API.md §9) - this service's INSERT ... ON CONFLICT DO NOTHING is how it
 * observes "I lost the race" without a separate SELECT-then-INSERT gap.
 */
export class IdempotencyService {
  constructor(
    private readonly database: Queryable,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Runs `fn` under idempotency protection for `scope`/`key`, or replays
   * the previously recorded response if this exact request already
   * completed. Returns the response to send to the client.
   */
  async run(
    scope: IdempotencyScope,
    method: string,
    body: unknown,
    fn: () => Promise<RecordedResponse>,
  ): Promise<RecordedResponse> {
    if (!(await this.settings.get("idempotency.enabled"))) {
      return fn();
    }

    const requestHash = computeRequestHash(method, scope.operationScope, body);
    const ttlHours = await this.settings.get("idempotency.ttl_hours");

    // An expired key is an unused one (Data_API.md §9): the
    // conflicting row is taken over in the same statement - fresh id, so a
    // request still holding the old one can no longer complete or release
    // it - while a live key conflicts and is resolved below.
    const { rows: inserted } = await this.database.query<{ id: string }>(
      `INSERT INTO totalbase.idempotency_keys AS existing
         (key, principal_type, principal, operation_scope, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)
       ON CONFLICT (principal_type, principal, operation_scope, key) DO UPDATE SET
         id = excluded.id, request_hash = excluded.request_hash, status = 'IN_PROGRESS',
         response_status = NULL, response_body = NULL, response_truncated = false,
         created_at = now(), expires_at = excluded.expires_at
       WHERE existing.expires_at <= now()
       RETURNING id`,
      [scope.key, scope.principalType, scope.principal, scope.operationScope, requestHash, ttlHours],
    );

    if (inserted.length === 0) {
      return this.resolveExisting(scope, requestHash);
    }

    const recordId = inserted[0]!.id;
    let response: RecordedResponse;
    try {
      response = await fn();
    } catch (error) {
      // The operation did not durably succeed - release the slot so a
      // genuine retry with the same key is not blocked forever.
      await this.database.query(`DELETE FROM totalbase.idempotency_keys WHERE id = $1`, [recordId]);
      throw error;
    }
    // From here the write is committed: recording its response may fail, releasing the key may not - a
    // retry would run the write again. The record stays IN_PROGRESS (a retry is told so until it expires)
    // and the caller still gets the response its write earned.
    const serializedBody = JSON.stringify(response.body ?? null);
    const maxResponseBytes = await this.settings.get("idempotency.max_response_bytes");
    // Byte length, not character length - matters for non-ASCII bodies.
    const tooLarge = Buffer.byteLength(serializedBody, "utf-8") > maxResponseBytes;
    await this.database.query(
      `UPDATE totalbase.idempotency_keys
       SET status = 'DONE', response_status = $2, response_body = $3, response_truncated = $4
       WHERE id = $1`,
      [recordId, response.status, tooLarge ? null : serializedBody, tooLarge],
    ).catch(() => undefined);
    return response;
  }

  private async resolveExisting(scope: IdempotencyScope, requestHash: string): Promise<RecordedResponse> {
    const { rows } = await this.database.query<{
      request_hash: string;
      status: string;
      response_status: number | null;
      response_body: unknown;
      response_truncated: boolean;
    }>(
      `SELECT request_hash, status, response_status, response_body, response_truncated FROM totalbase.idempotency_keys
       WHERE principal_type = $1 AND principal = $2 AND operation_scope = $3 AND key = $4 AND expires_at > now()`,
      [scope.principalType, scope.principal, scope.operationScope, scope.key],
    );
    const existing = rows[0];
    if (!existing) {
      // Lost the row between the failed INSERT and this SELECT (e.g. the
      // holder just deleted it after a failure, or it expired that
      // instant) - safe to treat as a fresh attempt by the caller retrying
      // the whole run() call.
      throw new TotalBaseError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "This idempotency key is currently being processed. Retry shortly.",
      );
    }
    if (existing.request_hash !== requestHash) {
      throw new TotalBaseError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used with a different request.",
      );
    }
    if (existing.status !== "DONE") {
      throw new TotalBaseError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "This idempotency key is currently being processed. Retry shortly.",
      );
    }
    if (existing.response_truncated) {
      // The operation already ran exactly once - that guarantee still
      // holds. Only the convenience of replaying the original response
      // body is unavailable because it exceeded idempotency.max_response_bytes.
      throw new TotalBaseError(
        "IDEMPOTENCY_RESPONSE_TOO_LARGE_TO_REPLAY",
        "This idempotency key already completed successfully, but its response was too large to cache and cannot be replayed. The operation was not re-executed.",
      );
    }
    return { status: existing.response_status ?? 200, body: existing.response_body };
  }

  /**
   * Deletes expired keys (the server's hourly retention job). An expired
   * key is already treated as unused by run(); this only reclaims space.
   * An expired IN_PROGRESS row can't belong to a live request: its
   * lifetime (idempotency.ttl_hours, at least 1 hour) outlasts any
   * request (api.request_timeout_ms, at most 1 hour) - it was left by a
   * process that died.
   */
  async purgeExpired(): Promise<number> {
    const { rowCount } = await this.database.query(`DELETE FROM totalbase.idempotency_keys WHERE expires_at <= now()`);
    return rowCount ?? 0;
  }
}
