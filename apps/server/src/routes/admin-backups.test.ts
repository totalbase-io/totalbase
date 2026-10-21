import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

/**
 * Settings > PostgreSQL > Backups (Administration.md §12.4): the queue and its refusals. No worker runs here - the
 * backup itself (pg_dump, the archive, restore) is @totalbase/backups' own integration test.
 */
describe("/admin/api/backups", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const call = (method: "GET" | "POST" | "DELETE", url: string) => app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await context.settings.set("backups.enabled", true);
  });
  beforeEach(async () => {
    await database.query(`DELETE FROM totalbase.backups`);
  });
  afterAll(async () => {
    await context.settings.reset("backups.enabled");
    await database.query(`DELETE FROM totalbase.backups`);
    await app.close();
  });

  it("queues Back up now once - a second one while it waits is BACKUP_ALREADY_QUEUED - and audits it", async () => {
    const queued = await call("POST", "/admin/api/backups");
    expect(queued.statusCode).toBe(202);
    const backup = queued.json().data;
    expect(backup).toMatchObject({ status: "PENDING", trigger: "MANUAL", destination: "LOCAL" });
    expect(backup.name).toMatch(/^totalbase-\d{8}-\d{6}-[0-9a-f]{8}\.tar$/);
    expect((await call("POST", "/admin/api/backups")).json().errors[0].code).toBe("BACKUP_ALREADY_QUEUED");

    const list = (await call("GET", "/admin/api/backups")).json();
    expect(list.data.map((b: { id: string }) => b.id)).toEqual([backup.id]);
    expect(list.meta).toMatchObject({ total: 1, destination: "LOCAL", schedule: expect.any(String) });
    // A page past the last holds nothing; the total stays.
    const past = (await call("GET", "/admin/api/backups?page=2&limit=1")).json();
    expect(past.data).toEqual([]);
    expect(past.meta.total).toBe(1);
    const { rows } = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM totalbase.logs WHERE action = 'BACKUP' AND metadata->>'backup' = $1 AND metadata->>'event' = 'QUEUED'`, [backup.id]);
    expect(rows[0]!.n).toBe(1);
  });

  it("never deletes or downloads a backup under way, and a failed one has no archive", async () => {
    const backup = (await call("POST", "/admin/api/backups")).json().data;
    expect((await call("DELETE", `/admin/api/backups/${backup.id}`)).json().errors[0].code).toBe("BACKUP_RUNNING");
    expect((await call("POST", `/admin/api/backups/${backup.id}/download`)).statusCode).toBe(409);

    await database.query(`UPDATE totalbase.backups SET status = 'FAILED', error = 'pg_dump failed' WHERE id = $1`, [backup.id]);
    expect((await call("POST", `/admin/api/backups/${backup.id}/download`)).json().errors[0].code).toBe("BACKUP_NOT_FOUND");
    // The latest backup to end failed: Status says so.
    const attention = (await call("GET", "/admin/api/dashboard")).json().data.attention as { key: string }[];
    expect(attention.map((a) => a.key)).toContain("backup_failed");
    expect((await call("DELETE", `/admin/api/backups/${backup.id}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/admin/api/backups/${backup.id}`)).statusCode).toBe(404);
    expect((await call("DELETE", "/admin/api/backups/not-an-id")).statusCode).toBe(404);
  });

  it("downloads a completed archive through a signed link, which works without a session and only as signed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tb-backups-route-"));
    await context.settings.set("backups.local_path", directory);
    try {
      const backup = (await call("POST", "/admin/api/backups")).json().data;
      await database.query(`UPDATE totalbase.backups SET status = 'COMPLETED', size_bytes = 7 WHERE id = $1`, [backup.id]);
      await writeFile(join(directory, backup.name), "archive");
      const link = (await call("POST", `/admin/api/backups/${backup.id}/download`)).json().data;
      expect(link.url).toMatch(new RegExp(`^/admin/api/backups/${backup.id}/archive\\?`));

      const archive = await app.inject({ method: "GET", url: link.url });
      expect(archive.statusCode).toBe(200);
      expect(archive.body).toBe("archive");
      expect(archive.headers["content-disposition"]).toBe(`attachment; filename="${backup.name}"`);
      // A signature for another link - or none - names no archive.
      const tampered = link.url.replace(/signature=([0-9a-f])/, (_m: string, c: string) => `signature=${c === "0" ? "1" : "0"}`);
      expect((await app.inject({ method: "GET", url: tampered })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/admin/api/backups/${backup.id}/archive` })).statusCode).toBe(404);
      const { rows } = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM totalbase.logs WHERE action = 'BACKUP' AND metadata->>'backup' = $1 AND metadata->>'event' = 'DOWNLOADED'`, [backup.id]);
      expect(rows[0]!.n).toBe(1);
    } finally {
      await context.settings.reset("backups.local_path");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("queues a scheduled occurrence once, whatever the number of ticks in its minute", async () => {
    await context.settings.set("backups.schedule", "* * * * *");
    try {
      const now = new Date();
      expect(await context.backups.scheduleTick(now)).toMatchObject({ trigger: "SCHEDULED" });
      expect(await context.backups.scheduleTick(now)).toBeNull();
    } finally {
      await context.settings.reset("backups.schedule");
    }
  });

  it("queues nothing while backups are off - neither the schedule nor Back up now - and keeps listing what was made", async () => {
    await call("POST", "/admin/api/backups");
    await database.query(`UPDATE totalbase.backups SET status = 'FAILED'`);
    await context.settings.set("backups.enabled", false);
    await context.settings.set("backups.schedule", "* * * * *");
    try {
      expect((await call("POST", "/admin/api/backups")).json().errors[0].code).toBe("BACKUPS_DISABLED");
      expect(await context.backups.scheduleTick(new Date())).toBeNull();
      expect((await call("GET", "/admin/api/backups")).json().data).toHaveLength(1);
    } finally {
      await context.settings.set("backups.enabled", true);
      await context.settings.reset("backups.schedule");
    }
  });

  it("writes to S3 only through an enabled connection", async () => {
    await expect(context.settings.set("backups.destination", "s3")).rejects.toThrow(/Enable S3 storage/);
  });
});
