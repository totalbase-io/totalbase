import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

// Per-run names: a run killed halfway leaves nothing a later run trips over.
const RUN = Date.now().toString(36);
const TABLE = `query_features_test_items_${RUN}`;
const VIEW = `query_features_test_slow_${RUN}`;
const FEATURE_KEYS = ["api.allow_count", "query.allow_regex", "query.allow_contains", "query.allow_having"] as const;
const KEYS = [...FEATURE_KEYS, "api.request_timeout_ms"] as const;

describe("Data API request settings (api.allow_count, query.allow_*, api.request_timeout_ms)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let resourceId: string;
  let viewResourceId: string;
  let roleId: string | undefined;
  let token: { plainKey: string; tokenId: string; userId: string } | undefined;
  const saved = new Map<string, { overridden: boolean; value: unknown }>();

  const get = (query: string) =>
    app.inject({ method: "GET", url: `/api/public/table/${TABLE}?${query}`, headers: { authorization: `Bearer ${token!.plainKey}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    for (const key of KEYS) saved.set(key, { overridden: await context.settings.isOverridden(key), value: await context.settings.get(key) });
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id integer PRIMARY KEY, name text NOT NULL, tags text[] NOT NULL DEFAULT '{}')`);
    await database.query(`INSERT INTO public.${TABLE} VALUES (1, 'alpha', '{a}'), (2, 'beta', '{b}')`);
    // Half a second per row: long enough to outlast a short timeout.
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT id, pg_sleep(0.5)::text AS slept FROM public.${TABLE}`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET', 'PATCH']) RETURNING id`,
      [`public.${TABLE}`, TABLE],
    );
    resourceId = rows[0]!.id;
    roleId = (await context.roles.create(`query-features-test-role-${RUN}`, { apiAccess: true })).id;
    const fields = ["id", "name", "tags"].map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", fields });
    await context.permissions.set(roleId, resourceId, "UPDATE", { effect: "ALLOW", fields });
    const { rows: viewRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'VIEW', 'ACTIVE', ARRAY['GET']) RETURNING id`,
      [`public.${VIEW}`, VIEW],
    );
    viewResourceId = viewRows[0]!.id;
    await context.permissions.set(roleId, viewResourceId, "READ", {
      effect: "ALLOW",
      fields: ["id", "slept"].map((field) => ({ field, effect: "ALLOW" as const })),
    });
    token = await createTestApiToken(context, { name: "query-features-test", roleId, email: `query-features-test-${RUN}@example.com` });
  });

  afterAll(async () => {
    // Shared with local development: leave these as they were.
    for (const key of KEYS) {
      const entry = saved.get(key)!;
      if (entry.overridden) await context.settings.set(key, entry.value as never);
      else await context.settings.reset(key);
    }
    // Each by its own id, each guarded: a beforeAll that died halfway still gets what it did create removed.
    if (token) await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [token.tokenId]);
    if (token) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [token.userId]);
    if (roleId) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [[resourceId, viewResourceId].filter(Boolean)]);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
    await database.close();
  });

  it("answers normally while every feature is on", async () => {
    for (const key of FEATURE_KEYS) await context.settings.set(key, true);
    const res = await get("count=true&where[name][_regex]=^a&where[tags][_overlap]=%7Ba%7D");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.map((row: { id: number }) => row.id)).toEqual([1]);
  });

  it("refuses a read using a switched-off feature, before touching PostgreSQL", async () => {
    const cases: Array<[(typeof FEATURE_KEYS)[number], string]> = [
      ["api.allow_count", "count=true"],
      ["query.allow_regex", "where[name][_regex]=^a"],
      ["query.allow_contains", "where[tags][_contains]=%7Ba%7D"],
      ["query.allow_having", "group_by=name&_count[*]=n&having[name][_eq]=alpha"],
    ];
    for (const [key, query] of cases) {
      await context.settings.set(key, false);
      const res = await get(query);
      expect([res.statusCode, res.json().errors?.[0]?.code], key).toEqual([400, "QUERY_FEATURE_DISABLED"]);
      await context.settings.set(key, true);
    }
  });

  it("applies to a bulk write's where too", async () => {
    await context.settings.set("query.allow_regex", false);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/public/table/${TABLE}?where[name][_regex]=^a`,
      headers: { authorization: `Bearer ${token!.plainKey}` },
      payload: { data: { name: "gamma" } },
    });
    expect([res.statusCode, res.json().errors?.[0]?.code]).toEqual([400, "QUERY_FEATURE_DISABLED"]);
    await context.settings.set("query.allow_regex", true);
  });

  it("lets PostgreSQL cancel a request that outlasts api.request_timeout_ms", async () => {
    const read = () =>
      app.inject({ method: "GET", url: `/api/public/view/${VIEW}`, headers: { authorization: `Bearer ${token!.plainKey}` } });
    await context.settings.set("api.request_timeout_ms", 200);
    const res = await read();
    expect([res.statusCode, res.json().errors?.[0]?.code]).toEqual([503, "QUERY_CANCELED"]);
    await context.settings.set("api.request_timeout_ms", 30_000);
    expect((await read()).statusCode).toBe(200);
  });
});
