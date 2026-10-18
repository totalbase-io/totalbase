import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const ZONE = "America/Argentina/Buenos_Aires";

/**
 * GET /admin/api/dashboard - needs-attention items, headline counts, 14
 * days of activity in the viewer's zone, the busiest resources and the
 * system's state.
 */
describe("GET /admin/api/dashboard", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let resourceId: string;
  let missingResourceId: string;
  let outboxId: string;

  const get = (query = `?tz=${encodeURIComponent(ZONE)}`) =>
    app.inject({ method: "GET", url: `/admin/api/dashboard${query}`, headers: { authorization: `Bearer ${adminToken}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.admin_dashboard_test_items CASCADE`);
    await database.query(`CREATE TABLE public.admin_dashboard_test_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.admin_dashboard_test_items')::oid, 'public', 'admin_dashboard_test_items', 'TABLE', 'ACTIVE', ARRAY['GET'])
       RETURNING id`,
    )).rows[0]!.id;
    // A resource whose PostgreSQL object is gone.
    missingResourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (2147483000, 'public', 'admin_dashboard_test_gone', 'TABLE', 'MISSING', '{}')
       RETURNING id`,
    )).rows[0]!.id;

    // Activity on the app table, and far more on one of TotalBase's own.
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, resource, action, status, source, started_at)
       VALUES (gen_random_uuid(), 'ADMIN', $1, 'CREATE', 'EXECUTED', 'admin-dashboard-test', now())`,
      [resourceId],
    );
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, resource, action, status, source, started_at)
       SELECT gen_random_uuid(), 'ADMIN', r.id, 'UPDATE', 'EXECUTED', 'admin-dashboard-test', now()
       FROM totalbase.resources r, generate_series(1, 50)
       WHERE r."schema" = 'totalbase' AND r.name = 'roles'`,
    );
    // Two denied and three failed actions today.
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, resource, action, status, source, started_at)
       SELECT gen_random_uuid(), 'ADMIN', $1, 'READ', s, 'admin-dashboard-test', now()
       FROM unnest(ARRAY['DENIED', 'DENIED', 'FAILED', 'FAILED', 'FAILED']) AS s`,
      [resourceId],
    );
    outboxId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.outbox (request_id, resource, event, payload, status)
       VALUES (gen_random_uuid(), $1, 'CREATE', '{}', 'FAILED') RETURNING id`,
      [resourceId],
    )).rows[0]!.id;

    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.outbox WHERE id = $1`, [outboxId]);
    await database.query(`DELETE FROM totalbase.logs WHERE source = 'admin-dashboard-test'`);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [[resourceId, missingResourceId]]);
    await database.query(`DROP TABLE IF EXISTS public.admin_dashboard_test_items CASCADE`);
    await app.close();
  });

  it("groups 14 days of activity by category, ending today in the viewer's zone", async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    const { activity } = res.json().data;
    expect(activity.timeZone).toBe(ZONE);
    expect(activity.days).toHaveLength(14);
    const { rows } = await database.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [ZONE]);
    expect(activity.days.at(-1).day).toBe(rows[0]!.today);
    expect(activity.days.at(-1).data).toBeGreaterThanOrEqual(51);
  });

  it("counts denied and failed actions and finished workflow runs per day, over the same days", async () => {
    const { activity, trends } = (await get()).json().data;
    for (const series of [trends.problems, trends.workflowRuns]) {
      expect(series.map((d: { day: string }) => d.day)).toEqual(activity.days.map((d: { day: string }) => d.day));
    }
    expect(trends.problems.at(-1).denied).toBeGreaterThanOrEqual(2);
    expect(trends.problems.at(-1).failed).toBeGreaterThanOrEqual(3);
  });

  it("breaks the database's space down by schema and by TotalBase table, largest first", async () => {
    const { space } = (await get()).json().data.system;
    const schemas = space.schemas.map((s: { schema: string }) => s.schema);
    expect(schemas).toEqual(expect.arrayContaining(["public", "totalbase"]));
    expect(schemas).not.toContain("pg_catalog");
    expect(space.totalbase.map((t: { table: string }) => t.table)).toContain("logs");
    for (const list of [space.schemas, space.totalbase]) {
      const sizes = list.map((x: { bytes: number }) => x.bytes);
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    }
  });

  it("lists only the application's resources among the busiest, never TotalBase's own tables", async () => {
    const { topResources } = (await get()).json().data;
    expect(topResources.some((r: { id: string }) => r.id === resourceId)).toBe(true);
    expect(topResources.every((r: { schema: string }) => r.schema !== "totalbase")).toBe(true);
  });

  it("counts people and the application's resources - not system accounts or internal tables", async () => {
    const { kpis } = (await get()).json().data;
    const { rows } = await database.query<{ people: number; total: number; exposed: number }>(
      `SELECT (SELECT count(*)::int FROM totalbase.users WHERE active AND can_login) AS people,
              (SELECT count(*)::int FROM totalbase.resources WHERE "schema" <> 'totalbase' AND status = 'ACTIVE') AS total,
              (SELECT count(*)::int FROM totalbase.resources WHERE "schema" <> 'totalbase' AND status = 'ACTIVE' AND exposed_methods <> '{}') AS exposed`,
    );
    expect(kpis.people).toBe(rows[0]!.people);
    expect(kpis.resources).toEqual({ total: rows[0]!.total, exposed: rows[0]!.exposed });
    expect(kpis.actions24h.total).toBeGreaterThanOrEqual(51);
  });

  it("raises what needs attention, and only what has a count", async () => {
    const { attention } = (await get()).json().data;
    const byKey = Object.fromEntries(attention.map((a: { key: string; count: number }) => [a.key, a]));
    expect(byKey.outbox_failed).toMatchObject({ severity: "error" });
    expect(byKey.outbox_failed.count).toBeGreaterThanOrEqual(1);
    expect(byKey.missing_resources.count).toBeGreaterThanOrEqual(1);
    expect(attention.every((a: { count: number }) => a.count > 0)).toBe(true);
  });

  it("reports the database and the pool", async () => {
    const { system } = (await get()).json().data;
    expect(system.postgres.version).toMatch(/^\d+/);
    expect(system.postgres.sizeBytes).toBeGreaterThan(0);
    expect(system.postgres.maxConnections).toBeGreaterThan(0);
    expect(system.pool.max).toBeGreaterThan(0);
  });

  it("rejects a zone PostgreSQL doesn't know unless an offset comes with it", async () => {
    expect((await get("?tz=Mars/Olympus")).statusCode).toBe(400);
    const res = await get("?tz=Mars/Olympus&offset=-180");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.activity.timeZone).toBe("UTC-03:00");
  });

  it("rejects unauthenticated requests", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/api/dashboard" })).statusCode).toBe(401);
  });
});
