import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const TABLE = "maintenance_actions_test_t";
const OTHER = "maintenance_actions_test_u";

describe("Settings > Maintenance actions", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let tableOid: number;
  let indexOid: number;
  let otherOid: number;
  let asyncWasOverridden = false;

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${adminToken}` } });
  const runs = async () =>
    (await app.inject({ method: "GET", url: "/admin/api/maintenance/runs", headers: { authorization: `Bearer ${adminToken}` } })).json().data as Array<{
      id: string;
      status: string;
      operation: string;
      error: string | null;
    }>;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    asyncWasOverridden = await context.settings.isOverridden("async_executions.enabled");
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`CREATE TABLE public.${TABLE} (id int PRIMARY KEY, label text)`);
    await database.query(`CREATE INDEX ${TABLE}_label_idx ON public.${TABLE} (label)`);
    await database.query(`INSERT INTO public.${TABLE} SELECT g, 'row ' || g FROM generate_series(1, 200) g`);
    tableOid = (await database.query<{ oid: number }>(`SELECT to_regclass($1)::oid::int AS oid`, [`public.${TABLE}`])).rows[0]!.oid;
    indexOid = (await database.query<{ oid: number }>(`SELECT to_regclass($1)::oid::int AS oid`, [`public.${TABLE}_label_idx`])).rows[0]!.oid;
    await database.query(`DROP TABLE IF EXISTS public.${OTHER}`);
    await database.query(`CREATE TABLE public.${OTHER} (id int PRIMARY KEY)`);
    otherOid = (await database.query<{ oid: number }>(`SELECT to_regclass($1)::oid::int AS oid`, [`public.${OTHER}`])).rows[0]!.oid;
  });

  afterAll(async () => {
    // Shared with local development: leave the worker switch as it was.
    if (!asyncWasOverridden) await context.settings.reset("async_executions.enabled");
    await database.query(`DELETE FROM totalbase.executions WHERE type = 'MAINTENANCE' AND request->>'label' LIKE 'public.maintenance_actions_test%'`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`DROP TABLE IF EXISTS public.${OTHER}`);
    await app.close();
    await database.close();
  });

  it("queues VACUUM, runs it in the executions worker, and audits it", async () => {
    await context.settings.set("async_executions.enabled", true);
    const queued = await post(`/admin/api/maintenance/tables/${tableOid}/vacuum`);
    expect(queued.statusCode, queued.body).toBe(202);
    expect(queued.json().data).toMatchObject({ operation: "VACUUM", status: "PENDING", label: `public.${TABLE}` });

    // A second one while the first is still queued is refused.
    expect((await post(`/admin/api/maintenance/tables/${tableOid}/vacuum`)).json().errors[0].code).toBe("MAINTENANCE_ALREADY_QUEUED");

    await context.maintenanceWorker.processBatch(1);
    const run = (await runs()).find((r) => r.id === queued.json().data.id)!;
    expect(run, JSON.stringify(run)).toMatchObject({ status: "COMPLETED", error: null });

    const { rows } = await database.query(
      `SELECT sql_text FROM totalbase.logs WHERE action = 'MAINTENANCE' AND request_id = $1`,
      [run.id],
    );
    expect(rows[0]?.sql_text).toBe(`VACUUM (ANALYZE) "public"."${TABLE}"`);
  });

  it("reindexes one index concurrently", async () => {
    const queued = await post(`/admin/api/maintenance/tables/${tableOid}/reindex`, { data: { index: indexOid } });
    expect(queued.statusCode, queued.body).toBe(202);
    await context.maintenanceWorker.processBatch(1);
    expect((await runs()).find((r) => r.id === queued.json().data.id)).toMatchObject({ operation: "REINDEX", status: "COMPLETED" });
  });

  it("refuses what it can't run: an unknown table, an index with VACUUM, an unknown operation, the worker off", async () => {
    expect((await post(`/admin/api/maintenance/tables/1/analyze`)).statusCode).toBe(404);
    expect((await post(`/admin/api/maintenance/tables/${tableOid}/vacuum`, { data: { index: indexOid } })).statusCode).toBe(400);
    expect((await post(`/admin/api/maintenance/tables/${tableOid}/full`)).statusCode).toBe(400);
    await context.settings.set("async_executions.enabled", false);
    expect((await post(`/admin/api/maintenance/tables/${tableOid}/analyze`)).json().errors[0].code).toBe("ASYNC_EXECUTIONS_DISABLED");
    await context.settings.set("async_executions.enabled", true);
  });

  it("answers 404 for the indexes of a table that doesn't exist, or an OID that can't be one", async () => {
    const indexes = (oid: string) => app.inject({ method: "GET", url: `/admin/api/maintenance/tables/${oid}/indexes`, headers: { authorization: `Bearer ${adminToken}` } });
    const listed = await indexes(String(tableOid));
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.map((index: { name: string }) => index.name)).toContain(`${TABLE}_label_idx`);
    for (const oid of ["1", "abc"]) {
      const res = await indexes(oid);
      expect([res.statusCode, res.json().errors[0].code], oid).toEqual([404, "RESOURCE_NOT_FOUND"]);
    }
    expect((await post("/admin/api/maintenance/tables/abc/analyze")).statusCode).toBe(404);
  });

  describe("batches", () => {
    const batchPost = (payload: Record<string, unknown>) => post("/admin/api/maintenance/batches", { data: payload });
    const get = async (url: string) =>
      (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${adminToken}` } })).json().data;

    it("runs a batch one table at a time, and allows only one batch at a time", async () => {
      await context.settings.set("async_executions.enabled", true);
      const started = await batchPost({ operation: "vacuum", targets: [{ table: tableOid }, { table: otherOid }] });
      expect(started.statusCode, started.body).toBe(202);
      const batch = started.json().data;
      expect(batch).toMatchObject({ operation: "VACUUM", active: true, total: 2, pending: 2, done: 0 });

      expect((await get("/admin/api/maintenance/batches/current")).id).toBe(batch.id);
      expect((await batchPost({ operation: "analyze", targets: [{ table: tableOid }] })).json().errors[0].code).toBe("MAINTENANCE_BATCH_RUNNING");
      expect((await post(`/admin/api/maintenance/tables/${tableOid}/analyze`)).json().errors[0].code).toBe("MAINTENANCE_BATCH_RUNNING");

      expect(await context.maintenanceWorker.processBatch(1)).toBe(1);
      expect(await get(`/admin/api/maintenance/batches/${batch.id}`)).toMatchObject({ done: 1, pending: 1, active: true });
      await context.maintenanceWorker.processBatch(1);
      expect(await get(`/admin/api/maintenance/batches/${batch.id}`)).toMatchObject({ done: 2, pending: 0, active: false });
      expect(await get("/admin/api/maintenance/batches/current")).toBeNull();
    });

    it("stops a batch: what hasn't started is cancelled and never runs", async () => {
      const batch = (await batchPost({ operation: "analyze", targets: [{ table: tableOid }, { table: otherOid }, { table: tableOid }] })).json().data;
      await context.maintenanceWorker.processBatch(1);
      const stopped = await post(`/admin/api/maintenance/batches/${batch.id}/stop`);
      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(stopped.json().data).toMatchObject({ active: false, done: 1, cancelled: 2 });
      expect(await context.maintenanceWorker.processBatch(1)).toBe(0);
    });

    it("rebuilds a list of indexes, and refuses a batch with any target it can't run", async () => {
      // REINDEX CONCURRENTLY builds a new index and drops the old one: the
      // earlier test's rebuild gave this index a new OID.
      indexOid = (await database.query<{ oid: number }>(`SELECT to_regclass($1)::oid::int AS oid`, [`public.${TABLE}_label_idx`])).rows[0]!.oid;
      const reindex = await batchPost({ operation: "reindex", targets: [{ table: tableOid, index: indexOid }] });
      expect(reindex.statusCode, reindex.body).toBe(202);
      const batch = reindex.json().data;
      await context.maintenanceWorker.processBatch(1);
      expect(await get(`/admin/api/maintenance/batches/${batch.id}`)).toMatchObject({ done: 1, failed: 0 });

      expect((await batchPost({ operation: "vacuum", targets: [{ table: tableOid }, { table: 1 }] })).statusCode).toBe(404);
      expect((await batchPost({ operation: "vacuum", targets: [{ table: tableOid, index: indexOid }] })).statusCode).toBe(400);
      expect((await batchPost({ operation: "vacuum", targets: [] })).statusCode).toBe(400);
      expect(await get("/admin/api/maintenance/batches/current")).toBeNull();
    });
  });
});

