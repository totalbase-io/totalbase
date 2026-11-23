import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";
import { connectionsSeverity, isLocalUrl } from "./admin-dashboard.js";
import { TOTALBASE_VERSION } from "../version.js";

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

  it("groups 30 days of activity by category when no window is asked for, ending today in the viewer's zone", async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    const { activity } = res.json().data;
    expect(activity.timeZone).toBe(ZONE);
    expect(activity.data).toHaveLength(30);
    expect(activity.admin.map((d: { day: string }) => d.day)).toEqual(activity.data.map((d: { day: string }) => d.day));
    const { rows } = await database.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [ZONE]);
    expect(activity.data.at(-1).day).toBe(rows[0]!.today);
    // The fixture: 1 CREATE, 50 UPDATE and 5 READ today - all the Data API's.
    expect(activity.data.at(-1).create).toBeGreaterThanOrEqual(1);
    expect(activity.data.at(-1).update).toBeGreaterThanOrEqual(50);
    expect(activity.data.at(-1).read).toBeGreaterThanOrEqual(5);
  });

  it("charts the window asked for - 7, 14 or 30 days - and no other", async () => {
    for (const days of [7, 14]) {
      const { activity, trends } = (await get(`?days=${days}&tz=${encodeURIComponent(ZONE)}`)).json().data;
      expect(activity.data).toHaveLength(days);
      expect(activity.admin).toHaveLength(days);
      expect(trends.workflowRuns).toHaveLength(days);
    }
    for (const days of ["3", "90", "x"]) {
      const res = await get(`?days=${days}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("INVALID_QUERY");
    }
  });

  it("compares the last 24 hours' actions with the 24 before them", async () => {
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, resource, action, status, source, started_at, created_at)
       SELECT gen_random_uuid(), 'ADMIN', $1, 'READ', 'EXECUTED', 'admin-dashboard-test', now(), now() - interval '30 hours'
       FROM generate_series(1, 4)`,
      [resourceId],
    );
    const { rows } = await database.query<{ previous: number }>(
      `SELECT count(*)::int AS previous FROM totalbase.logs WHERE created_at >= now() - interval '48 hours' AND created_at < now() - interval '24 hours'`,
    );
    const { kpis } = (await get()).json().data;
    expect(kpis.actions24h.previous).toBe(rows[0]!.previous);
    expect(kpis.actions24h.previous).toBeGreaterThanOrEqual(4);
  });

  it("splits the administration's entries by area, and counts what was denied or failed on each side", async () => {
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, action, status, source, metadata, started_at)
       SELECT gen_random_uuid(), 'ADMIN', a.action, a.status, 'admin-dashboard-test', a.metadata::jsonb, now()
       FROM (VALUES ('DDL', 'EXECUTED', '{"event":"schema.apply"}'), ('SQL_EXECUTE', 'FAILED', '{}'), ('AUTH', 'EXECUTED', '{"event":"settings.update"}'),
                    ('AUTH', 'DENIED', '{"event":"auth.portal_login"}'), ('MAINTENANCE', 'EXECUTED', '{}')) AS a(action, status, metadata)`,
    );
    const before = (await database.query<{ data: number; admin: number }>(
      `SELECT count(*) FILTER (WHERE action IN ('CREATE','UPDATE','DELETE','READ','EXECUTE','IMPORT','EXPORT','PRINT'))::int AS data,
              count(*) FILTER (WHERE action NOT IN ('CREATE','UPDATE','DELETE','READ','EXECUTE','IMPORT','EXPORT','PRINT'))::int AS admin
       FROM totalbase.logs WHERE status IN ('DENIED', 'FAILED') AND created_at >= now() - interval '6 days'`,
    )).rows[0]!;
    const { activity, trends } = (await get(`?days=7&tz=${encodeURIComponent(ZONE)}`)).json().data;
    expect(trends.workflowRuns.map((d: { day: string }) => d.day)).toEqual(activity.data.map((d: { day: string }) => d.day));
    const today = activity.admin.at(-1);
    for (const area of ["schema", "sql", "config", "access", "other"]) expect(today[area], area).toBeGreaterThanOrEqual(1);
    // The fixture's 2 denied and 3 failed reads are the Data API's; the SQL and the sign-in above, the administration's.
    expect(activity.problems.data).toBeGreaterThanOrEqual(5);
    expect(activity.problems.admin).toBeGreaterThanOrEqual(2);
    expect(activity.problems.data).toBeLessThanOrEqual(before.data);
    expect(activity.problems.admin).toBeLessThanOrEqual(before.admin);
  });

  it("breaks the database's space down by schema and, in each, by its largest tables - largest first", async () => {
    const { space } = (await get()).json().data.system;
    type Schema = { schema: string; bytes: number; tables: Array<{ table: string; bytes: number }> };
    const schemas = space.schemas.map((s: Schema) => s.schema);
    expect(schemas).toEqual(expect.arrayContaining(["public", "totalbase"]));
    expect(schemas).not.toContain("pg_catalog");
    expect(space.schemas.find((s: Schema) => s.schema === "public").tables.map((t: { table: string }) => t.table)).toContain("admin_dashboard_test_items");
    const descending = (sizes: number[]) => expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    descending(space.schemas.map((s: Schema) => s.bytes));
    for (const schema of space.schemas as Schema[]) {
      descending(schema.tables.map((t) => t.bytes));
      expect(schema.tables.length).toBeLessThanOrEqual(10);
      // The tables named never add up to more than their schema.
      expect(schema.tables.reduce((sum, t) => sum + t.bytes, 0)).toBeLessThanOrEqual(schema.bytes);
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

  it("says what this instance is: version, environment, public URL, uptime and the lockdown", async () => {
    const { instance, system } = (await get()).json().data;
    expect(instance.version).toBe(TOTALBASE_VERSION);
    expect(instance.environment).toBe(context.nodeEnv);
    expect(instance.publicUrl).toBe(await context.auth.mailer.publicUrl());
    expect(instance.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(instance.lockdown).toEqual({ active: false, readOnly: expect.any(Boolean), endsAt: null, startsAt: null });
    expect(new Date(system.postgres.startedAt).getTime()).toBeLessThan(Date.now());
  });

  it("counts active sessions and the workflow runs finished in the last 24 hours", async () => {
    const { kpis } = (await get()).json().data;
    expect(kpis.sessionsActive).toBeGreaterThanOrEqual(1);
    const { rows } = await database.query<{ succeeded: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded, count(*) FILTER (WHERE status = 'FAILED')::int AS failed
       FROM totalbase.workflows_runs WHERE finished_at >= now() - interval '24 hours'`,
    );
    expect(kpis.workflowRuns24h).toEqual(rows[0]);
  });

  it("raises configuration that leaves the instance short: backups off, no SMTP", async () => {
    const keys = async () => (await get()).json().data.attention.map((a: { key: string }) => a.key);
    const before = { backups: await context.settings.get("backups.enabled"), host: await context.settings.get("smtp.host"), from: await context.settings.get("smtp.from") };
    try {
      await context.settings.set("backups.enabled", false);
      await context.settings.set("smtp.host", "");
      expect(await keys()).toEqual(expect.arrayContaining(["backups_off", "smtp_not_configured"]));
      await context.settings.set("backups.enabled", true);
      await context.settings.set("smtp.host", "smtp.example.com");
      await context.settings.set("smtp.from", "no-reply@example.com");
      const after = await keys();
      expect(after).not.toContain("backups_off");
      expect(after).not.toContain("smtp_not_configured");
      expect((await get()).json().data.system.backups.enabled).toBe(true);
    } finally {
      await context.settings.set("backups.enabled", before.backups);
      await context.settings.set("smtp.host", before.host);
      await context.settings.set("smtp.from", before.from);
    }
  });

  it("raises the security settings left off: rate limits, sign-in lockout, MFA for administrators", async () => {
    const keys = async () => (await get()).json().data.attention.map((a: { key: string }) => a.key);
    const before = {
      rateLimit: await context.settings.get("security.rate_limit_enabled"),
      perUser: await context.settings.get("security.rate_limit_per_user_per_minute"),
      trustedProxies: await context.settings.get("security.trusted_proxies"),
      lockout: await context.settings.get("auth.lockout_max_attempts"),
      mfa: await context.settings.get("mfa.required"),
      mfaRoles: await context.settings.get("mfa.required_roles"),
    };
    try {
      await context.settings.set("security.rate_limit_enabled", false);
      await context.settings.set("security.trusted_proxies", []);
      // The per-address limit off with no proxy trusted is the default, on purpose (Administration.md §7.8).
      expect(await keys()).not.toContain("rate_limit_off");
      await context.settings.set("security.trusted_proxies", ["10.0.0.5"]);
      await context.settings.set("security.rate_limit_per_user_per_minute", 0);
      await context.settings.set("auth.lockout_max_attempts", 0);
      await context.settings.set("mfa.required", "NONE");
      expect(await keys()).toEqual(expect.arrayContaining(["rate_limit_off", "user_rate_limit_off", "lockout_off", "mfa_not_required"]));
      // Selected roles that leave Administrators out still leave it uncovered.
      await context.settings.set("mfa.required", "ROLES");
      await context.settings.set("mfa.required_roles", []);
      expect(await keys()).toContain("mfa_not_required");
      await context.settings.set("security.rate_limit_enabled", true);
      await context.settings.set("security.rate_limit_per_user_per_minute", 1200);
      await context.settings.set("auth.lockout_max_attempts", 5);
      await context.settings.set("mfa.required_roles", [await context.roles.getAdministratorsRoleId()]);
      const after = await keys();
      for (const key of ["rate_limit_off", "user_rate_limit_off", "lockout_off", "mfa_not_required"]) expect(after).not.toContain(key);
    } finally {
      await context.settings.set("security.rate_limit_enabled", before.rateLimit);
      await context.settings.set("security.rate_limit_per_user_per_minute", before.perUser);
      await context.settings.set("security.trusted_proxies", before.trustedProxies);
      await context.settings.set("auth.lockout_max_attempts", before.lockout);
      await context.settings.set("mfa.required", before.mfa);
      await context.settings.set("mfa.required_roles", before.mfaRoles);
    }
  });

  it("names the privileges of the connection's role TotalBase doesn't need - REPLICATION only while Realtime is off", async () => {
    const { rows } = await database.query<{ superuser: boolean; createrole: boolean; replication: boolean }>(
      `SELECT rolsuper AS superuser, rolcreaterole AS createrole, rolreplication AS replication FROM pg_roles WHERE rolname = current_user`,
    );
    const role = rows[0]!;
    const item = async () => (await get()).json().data.attention.find((a: { key: string }) => a.key === "postgres_role_privileges") as { detail: string[] } | undefined;
    const before = await context.settings.get("realtime.enabled");
    try {
      await context.settings.set("realtime.enabled", false);
      const off = (await item())?.detail ?? [];
      expect(off.includes("CREATEROLE")).toBe(!role.superuser && role.createrole);
      expect(off.includes("REPLICATION")).toBe(!role.superuser && role.replication);
      await context.settings.set("realtime.enabled", true);
      expect((await item())?.detail ?? []).not.toContain("REPLICATION");
    } finally {
      await context.settings.set("realtime.enabled", before);
    }
  });

  it("raises a request forwarded by a proxy the server doesn't trust", async () => {
    const before = app.untrustedProxySeenAt;
    try {
      app.untrustedProxySeenAt = null;
      expect((await get()).json().data.attention.map((a: { key: string }) => a.key)).not.toContain("untrusted_proxy");
      await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "203.0.113.7" } });
      expect((await get()).json().data.attention.map((a: { key: string }) => a.key)).toContain("untrusted_proxy");
    } finally {
      app.untrustedProxySeenAt = before ?? null;
    }
  });

  it("counts the self-registration role's UPDATE and DELETE grants without a row filter, only while registration gives it", async () => {
    const count = async () => (await get()).json().data.attention.find((a: { key: string }) => a.key === "registration_unfiltered_writes")?.count ?? 0;
    const roleId = (await database.query<{ id: string }>(`INSERT INTO totalbase.roles (name) VALUES ('admin-dashboard-test-signup') RETURNING id`)).rows[0]!.id;
    const before = { enabled: await context.settings.get("auth.registration_enabled"), role: await context.settings.get("auth.registration_default_role") };
    try {
      await context.permissions.set(roleId, resourceId, "UPDATE", { effect: "ALLOW" });
      await context.permissions.set(roleId, resourceId, "DELETE", { effect: "ALLOW", where: { field: "name", operator: "_eq", value: "mine" } });
      await context.settings.set("auth.registration_default_role", roleId);
      await context.settings.set("auth.registration_enabled", false);
      expect(await count()).toBe(0);
      await context.settings.set("auth.registration_enabled", true);
      expect(await count()).toBe(1);
    } finally {
      await context.settings.set("auth.registration_enabled", before.enabled);
      await context.settings.set("auth.registration_default_role", before.role);
      await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    }
  });

  it("notes the exposed functions declared SECURITY DEFINER, not the hidden ones", async () => {
    const count = async () => (await get()).json().data.attention.find((a: { key: string }) => a.key === "definer_functions_exposed")?.count ?? 0;
    await database.query(`CREATE OR REPLACE FUNCTION public.admin_dashboard_test_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
    const base = await count();
    const id = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ('public.admin_dashboard_test_definer()'::regprocedure::oid, 'public', 'admin_dashboard_test_definer', 'FUNCTION', 'ACTIVE', '{}')
       RETURNING id`,
    )).rows[0]!.id;
    try {
      expect(await count()).toBe(base);
      await database.query(`UPDATE totalbase.resources SET exposed_methods = ARRAY['POST'] WHERE id = $1`, [id]);
      expect(await count()).toBe(base + 1);
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
      await database.query(`DROP FUNCTION public.admin_dashboard_test_definer()`);
    }
  });

  it("raises an http public URL only off this machine, and no unencrypted connection to a local PostgreSQL", async () => {
    expect(isLocalUrl("http://localhost:3030")).toBe(true);
    expect(isLocalUrl("http://app.localhost")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:3030")).toBe(true);
    expect(isLocalUrl("http://[::1]:3030")).toBe(true);
    expect(isLocalUrl("http://totalbase.example.com")).toBe(false);
    expect(isLocalUrl("http://192.168.1.10")).toBe(false);
    // The test servers run on this machine or its Docker network.
    expect((await get()).json().data.attention.map((a: { key: string }) => a.key)).not.toContain("postgres_tls_off");
  });

  it("warns from 80% of max_connections and calls it an error from 95%", () => {
    expect(connectionsSeverity(79, 100)).toBeNull();
    expect(connectionsSeverity(80, 100)).toBe("warning");
    expect(connectionsSeverity(94, 100)).toBe("warning");
    expect(connectionsSeverity(95, 100)).toBe("error");
    expect(connectionsSeverity(100, 100)).toBe("error");
  });

  it("lists errors before warnings, and those before notes", async () => {
    const order = { error: 0, warning: 1, info: 2 } as const;
    const ranks = (await get()).json().data.attention.map((a: { severity: keyof typeof order }) => order[a.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("lists the window's newest backups, whatever their status, and none from before it", async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.backups (status, trigger, destination, name, size_bytes, error, created_at, started_at, completed_at)
       VALUES ('COMPLETED', 'MANUAL', 'LOCAL', 'totalbase-20260101-000000-aaaaaaaa.tar', 2048, NULL, now() - interval '2 days', now() - interval '2 days', now() - interval '2 days' + interval '9 seconds'),
              ('FAILED', 'MANUAL', 'LOCAL', 'totalbase-20260101-000000-bbbbbbbb.tar', NULL, 'pg_dump: boom', now() - interval '10 days', now() - interval '10 days', now() - interval '10 days')
       RETURNING id`,
    );
    const [recentId, olderId] = rows.map((r) => r.id);
    try {
      type Recent = { id: string; status: string; sizeBytes: number | null; error: string | null; createdAt: string };
      const recent = async (days: number): Promise<Recent[]> => (await get(`?days=${days}`)).json().data.system.backups.recent;
      const month = await recent(30);
      expect(month.length).toBeLessThanOrEqual(5);
      expect(month.find((b) => b.id === recentId)).toMatchObject({ status: "COMPLETED", sizeBytes: 2048, error: null });
      expect(month.find((b) => b.id === olderId)).toMatchObject({ status: "FAILED", error: "pg_dump: boom" });
      const times = month.map((b) => new Date(b.createdAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const week = await recent(7);
      expect(week.some((b) => b.id === recentId)).toBe(true);
      expect(week.some((b) => b.id === olderId)).toBe(false);
    } finally {
      await database.query(`DELETE FROM totalbase.backups WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    }
  });

  it("lists what the instance has turned on, each by its own switch", async () => {
    const state = async (key: string) => (await get()).json().data.services.find((s: { key: string }) => s.key === key)?.state;
    const services = (await get()).json().data.services.map((s: { key: string }) => s.key);
    expect(services).toEqual(["smtp", "backups", "s3", "audit", "openapi", "graphql", "realtime", "mcp", "sql_console"]);
    const before = { graphql: await context.settings.get("graphql.enabled"), host: await context.settings.get("smtp.host") };
    try {
      await context.settings.set("graphql.enabled", true);
      await context.settings.set("smtp.host", "");
      expect(await state("graphql")).toBe("ON");
      expect(await state("smtp")).toBe("NOT_CONFIGURED");
      await context.settings.set("graphql.enabled", false);
      expect(await state("graphql")).toBe("OFF");
    } finally {
      await context.settings.set("graphql.enabled", before.graphql);
      await context.settings.set("smtp.host", before.host);
    }
  });

  it("counts failed asynchronous executions of the last 24 hours, and the queue", async () => {
    const userId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users ORDER BY created_at LIMIT 1`)).rows[0]!.id;
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.executions (type, status, principal_type, principal, completed_at)
       VALUES ('ADMIN_DASHBOARD_TEST', 'FAILED', 'USER', $1, now()), ('ADMIN_DASHBOARD_TEST', 'FAILED', 'USER', $1, now() - interval '3 days')
       RETURNING id`,
      [userId],
    );
    try {
      const { attention, system } = (await get()).json().data;
      const failed = (await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM totalbase.executions WHERE status = 'FAILED' AND completed_at >= now() - interval '24 hours'`)).rows[0]!.count;
      expect(system.executions.failed).toBe(failed);
      expect(attention.find((a: { key: string }) => a.key === "executions_failed")).toMatchObject({ severity: "error", count: failed });
      expect(system.maintenance.running).toEqual(expect.any(Boolean));
    } finally {
      await database.query(`DELETE FROM totalbase.executions WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    }
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
