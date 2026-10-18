import type { FastifyInstance } from "fastify";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp, waitFor } from "./test-support.js";

const TABLE = "maintenance_stop_test_t";

/**
 * Stopping a batch cancels the VACUUM running at that moment
 * (pg_cancel_backend) - the item ends CANCELLED, not failed. The VACUUM is
 * slowed down with vacuum_cost_delay, set on the database before the app
 * opens its pool so its connections pick it up, to have time to stop it.
 */
describe("stopping a batch cancels the VACUUM in progress", () => {
  let admin: Database;
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let tableOid: number;
  let databaseName: string;

  const request = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${adminToken}` } });

  beforeAll(async () => {
    admin = new Database(loadDatabaseConfigFromEnv());
    databaseName = (await admin.query<{ name: string }>(`SELECT current_database() AS name`)).rows[0]!.name;
    await admin.query(`ALTER DATABASE "${databaseName}" SET vacuum_cost_delay = '20ms'`);
    await admin.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await admin.query(`CREATE TABLE public.${TABLE} (id int, v text) WITH (autovacuum_enabled = false)`);
    await admin.query(`INSERT INTO public.${TABLE} SELECT g, repeat('x', 100) FROM generate_series(1, 150000) g`);
    await admin.query(`UPDATE public.${TABLE} SET v = repeat('y', 100)`);
    tableOid = (await admin.query<{ oid: number }>(`SELECT to_regclass($1)::oid::int AS oid`, [`public.${TABLE}`])).rows[0]!.oid;

    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await context.settings.set("async_executions.enabled", true);
  }, 120_000);

  afterAll(async () => {
    await admin.query(`ALTER DATABASE "${databaseName}" RESET vacuum_cost_delay`);
    await admin.query(`DELETE FROM totalbase.executions WHERE type = 'MAINTENANCE' AND request->>'label' = $1`, [`public.${TABLE}`]);
    await admin.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await context.settings.reset("async_executions.enabled");
    await app.close();
    await database.close();
    await admin.close();
  });

  it("cancels it with pg_cancel_backend and reports the item cancelled", async () => {
    const started = await request("POST", "/admin/api/maintenance/batches", { data: { operation: "vacuum", targets: [{ table: tableOid }] } });
    expect(started.statusCode, started.body).toBe(202);
    const batchId = started.json().data.id as string;

    const running = context.maintenanceWorker.processBatch(1);
    // Wait until PostgreSQL itself reports the VACUUM running.
    await waitFor(async () => (await admin.query(`SELECT 1 FROM pg_stat_progress_vacuum WHERE relid = $1`, [tableOid])).rows.length > 0, { timeoutMs: 10_000, intervalMs: 100 });

    expect((await request("POST", `/admin/api/maintenance/batches/${batchId}/stop`)).statusCode).toBe(200);
    await running;

    const batch = (await request("GET", `/admin/api/maintenance/batches/${batchId}`)).json().data;
    expect(batch).toMatchObject({ active: false, done: 0, cancelled: 1, failed: 0 });
    expect(batch.items[0]).toMatchObject({ status: "CANCELLED", error: null });
  }, 60_000);
});
