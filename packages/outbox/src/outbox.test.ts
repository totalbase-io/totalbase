import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueOutboxEvent } from "./outbox-producer.js";
import { getOutboxStats } from "./outbox-stats.js";
import { purgeProcessedOutboxEvents, releaseExpiredOutboxLeases, requeueFailedOutboxEvents } from "./outbox-retention.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("outbox (integration)", () => {
  let database: Database;
  let resourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    await database.query(`DELETE FROM totalbase.resources WHERE name = 'outbox_pkg_test'`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (2147483001, 'public', 'outbox_pkg_test', 'TABLE', 'ACTIVE', '{}') RETURNING id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]); // cascades its events
    await database.close();
  });

  it("enqueues inside the caller's transaction - rolled back with it", async () => {
    await expect(database.transaction(async (client) => {
      await enqueueOutboxEvent(client, { requestId: crypto.randomUUID(), resource: resourceId, event: "CREATE", payload: { id: 1 } });
      throw new Error("business operation failed");
    })).rejects.toThrow();
    const { rows } = await database.query(`SELECT 1 FROM totalbase.outbox WHERE resource = $1`, [resourceId]);
    expect(rows).toHaveLength(0);
  });

  it("counts pending and failed events and the oldest wait", async () => {
    const before = await getOutboxStats(database);
    const id = await database.transaction((client) =>
      enqueueOutboxEvent(client, { requestId: crypto.randomUUID(), resource: resourceId, event: "UPDATE", payload: {} }));
    await database.query(`UPDATE totalbase.outbox SET created_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    await database.query(
      `INSERT INTO totalbase.outbox (request_id, resource, event, payload, status) VALUES (gen_random_uuid(), $1, 'DELETE', '{}', 'FAILED')`,
      [resourceId],
    );
    const after = await getOutboxStats(database);
    expect(after.pending).toBe(before.pending + 1);
    expect(after.failed).toBe(before.failed + 1);
    expect(after.oldestPendingSeconds).toBeGreaterThanOrEqual(600);
  });

  const insertEvent = async (status: string, extra: string, params: unknown[] = []) =>
    (await database.query<{ id: string }>(
      `INSERT INTO totalbase.outbox (request_id, resource, event, payload, status, attempts, locked_at, processed_at)
       VALUES (gen_random_uuid(), $1, 'UPDATE', '{}', '${status}', ${extra}) RETURNING id`,
      [resourceId, ...params],
    )).rows[0]!.id;
  const statusOf = async (id: string) =>
    (await database.query<{ status: string }>(`SELECT status FROM totalbase.outbox WHERE id = $1`, [id])).rows[0]?.status;

  it("requeues a failed event once its backoff has elapsed, with attempts left only", async () => {
    // 1 attempt, failed 40 s ago: 30 s backoff elapsed -> PENDING.
    const due = await insertEvent("FAILED", "1, now() - interval '40 seconds', NULL");
    // 2 attempts, failed 40 s ago: 60 s backoff (doubled) not yet elapsed.
    const waiting = await insertEvent("FAILED", "2, now() - interval '40 seconds', NULL");
    // Out of attempts: stays FAILED for good.
    const exhausted = await insertEvent("FAILED", "5, now() - interval '1 day', NULL");

    const requeued = await requeueFailedOutboxEvents(database, { maxAttempts: 5, retryDelaySeconds: 30 });
    expect(requeued).toContain(due);
    expect(requeued).not.toContain(waiting);
    expect(requeued).not.toContain(exhausted);
    expect(await statusOf(due)).toBe("PENDING");
    expect(await statusOf(waiting)).toBe("FAILED");
    expect(await statusOf(exhausted)).toBe("FAILED");
  });

  it("caps the backoff exponent so a large attempt count never overflows", async () => {
    await insertEvent("FAILED", "90, now() - interval '1 second', NULL");
    await expect(requeueFailedOutboxEvents(database, { maxAttempts: 100, retryDelaySeconds: 3600 })).resolves.toBeDefined();
  });

  it("turns a PROCESSING event whose lease expired into a failed attempt; a live lease is kept", async () => {
    const expired = await insertEvent("PROCESSING", "1, now() - interval '30 minutes', NULL");
    await database.query(`UPDATE totalbase.outbox SET locked_until = now() - interval '1 second' WHERE id = $1`, [expired]);
    const live = await insertEvent("PROCESSING", "1, now(), NULL");
    await database.query(`UPDATE totalbase.outbox SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [live]);

    const released = await releaseExpiredOutboxLeases(database);
    expect(released).toContain(expired);
    expect(released).not.toContain(live);
    expect(await statusOf(expired)).toBe("FAILED");
    expect(await statusOf(live)).toBe("PROCESSING");
    // The retry step then re-queues it like any failed attempt.
    expect(await requeueFailedOutboxEvents(database, { maxAttempts: 5, retryDelaySeconds: 30 })).toContain(expired);
    expect(await statusOf(expired)).toBe("PENDING");
  });

  it("purges processed events past the retention window only", async () => {
    const old = await insertEvent("PROCESSED", "1, NULL, now() - interval '8 days'");
    const recent = await insertEvent("PROCESSED", "1, NULL, now() - interval '1 day'");
    const failedOld = await insertEvent("FAILED", "5, now() - interval '30 days', NULL");
    expect(await purgeProcessedOutboxEvents(database, 7)).toBeGreaterThanOrEqual(1);
    expect(await statusOf(old)).toBeUndefined();
    expect(await statusOf(recent)).toBe("PROCESSED");
    expect(await statusOf(failedOld)).toBe("FAILED");
  });
});
