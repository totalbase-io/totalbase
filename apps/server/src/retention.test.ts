import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { FilesLocalStorageProvider, FilesTransformService } from "@totalbase/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { requeueFailedOutbox, runRetention } from "./retention.js";
import { setupTestApp } from "./test-support.js";

describe("retention job (integration)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let resourceId: string;
  let storageDir: string;
  const logIds: string[] = [];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    storageDir = await mkdtemp(path.join(tmpdir(), "totalbase-retention-"));
    await database.query(`DELETE FROM totalbase.resources WHERE name = 'retention_job_test'`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (2147483101, 'public', 'retention_job_test', 'TABLE', 'ACTIVE', '{}') RETURNING id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE id = ANY($1::uuid[])`, [logIds]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]); // cascades its outbox events
    await rm(storageDir, { recursive: true, force: true });
    await app.close();
  });

  const outboxEvent = async (status: string, attempts: number, lockedAgo: string | null, processedAgo: string | null) =>
    (await database.query<{ id: string }>(
      `INSERT INTO totalbase.outbox (request_id, resource, event, payload, status, attempts, locked_at, processed_at)
       VALUES (gen_random_uuid(), $1, 'UPDATE', '{}', $2, $3, now() - $4::interval, now() - $5::interval) RETURNING id`,
      [resourceId, status, attempts, lockedAgo, processedAgo],
    )).rows[0]!.id;
  const outboxStatus = async (id: string) =>
    (await database.query<{ status: string }>(`SELECT status FROM totalbase.outbox WHERE id = $1`, [id])).rows[0]?.status;

  it("purges old audit entries (and audits the purge), expired idempotency keys and processed outbox events", async () => {
    const oldLog = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.logs (request_id, principal_type, action, status, source, started_at, created_at)
       VALUES (gen_random_uuid(), 'SYSTEM', 'AUTH', 'EXECUTED', 'test', now(), now() - interval '400 days') RETURNING id`,
    )).rows[0]!.id;
    const principal = randomUUID();
    await database.query(
      `INSERT INTO totalbase.idempotency_keys (key, principal_type, principal, operation_scope, request_hash, status, expires_at)
       VALUES ('expired', 'USER', $1, 'retention:test', 'h', 'DONE', now() - interval '1 hour'),
              ('live', 'USER', $1, 'retention:test', 'h', 'DONE', now() + interval '1 hour')`,
      [principal],
    );
    const processedOld = await outboxEvent("PROCESSED", 1, null, "8 days");
    const processedRecent = await outboxEvent("PROCESSED", 1, null, "1 day");

    const files = new FilesTransformService(context.settings, async () => new FilesLocalStorageProvider(storageDir));
    const result = await runRetention({ ...context, filesTransform: files });

    expect(result.auditLogs).toBeGreaterThanOrEqual(1);
    expect((await database.query(`SELECT 1 FROM totalbase.logs WHERE id = $1`, [oldLog])).rows).toHaveLength(0);
    const { rows: purgeEntries } = await database.query<{ id: string; metadata: { deletedCount: number; retentionDays: number } }>(
      `SELECT id, metadata FROM totalbase.logs WHERE action = 'AUDIT_PURGE' AND principal_type = 'SYSTEM' ORDER BY created_at DESC LIMIT 1`,
    );
    logIds.push(...purgeEntries.map((r) => r.id));
    expect(purgeEntries[0]?.metadata.retentionDays).toBe(365);

    const { rows: keys } = await database.query<{ key: string }>(`SELECT key FROM totalbase.idempotency_keys WHERE principal = $1`, [principal]);
    expect(keys.map((k) => k.key)).toEqual(["live"]);
    await database.query(`DELETE FROM totalbase.idempotency_keys WHERE principal = $1`, [principal]);

    expect(await outboxStatus(processedOld)).toBeUndefined();
    expect(await outboxStatus(processedRecent)).toBe("PROCESSED");
  });

  it("follows a changed retention window on the next run, without a restart", async () => {
    const processed = await outboxEvent("PROCESSED", 1, null, "2 days");
    const files = new FilesTransformService(context.settings, async () => new FilesLocalStorageProvider(storageDir));
    await runRetention({ ...context, filesTransform: files });
    expect(await outboxStatus(processed)).toBe("PROCESSED");
    await context.settings.set("outbox.retention_days", 1);
    try {
      await runRetention({ ...context, filesTransform: files });
      expect(await outboxStatus(processed)).toBeUndefined();
    } finally {
      await context.settings.reset("outbox.retention_days");
    }
  });

  it("requeues a failed outbox event whose retry is due, per the outbox.* settings", async () => {
    const due = await outboxEvent("FAILED", 1, "1 minute", null);
    const exhausted = await outboxEvent("FAILED", 5, "1 day", null);
    const requeued = await requeueFailedOutbox(context);
    expect(requeued).toContain(due);
    expect(await outboxStatus(due)).toBe("PENDING");
    expect(await outboxStatus(exhausted)).toBe("FAILED");
    await database.query(`DELETE FROM totalbase.outbox WHERE id = $1`, [due]); // never left for the fallback poller
  });
});
