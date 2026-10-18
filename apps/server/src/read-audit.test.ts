import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

const PREFIX = "read-audit-test";

/**
 * Data API READ audit (Specification_Security.md §11: "READ is configurable
 * per resource" - resources.audit_read). A read of a resource with
 * audit_read on writes one READ row describing the operation - fields,
 * filter, row count - and never the rows themselves (Specification_Security.md §11.5); with it
 * off, nothing is written.
 */
describe("Data API READ audit", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const resourceIds: Record<string, string> = {};
  let allowRoleId: string;
  let noGrantRoleId: string;
  let reader: { plainKey: string; userId: string; tokenId: string };
  let stranger: { plainKey: string; userId: string; tokenId: string };
  const secret = "s3cret-value-never-logged";

  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function register(name: string, type: "TABLE" | "VIEW", auditRead: boolean): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods, audit_read)
       VALUES (to_regclass($1)::oid, 'public', $2, $3, 'ACTIVE', ARRAY['GET'], $4)
       RETURNING id`,
      [`public.${name}`, name, type, auditRead],
    );
    return rows[0]!.id;
  }

  async function logsFor(resourceId: string) {
    const { rows } = await database.query<Record<string, unknown>>(
      `SELECT * FROM totalbase.logs WHERE resource = $1 AND action = 'READ' ORDER BY created_at`,
      [resourceId],
    );
    return rows;
  }

  async function clearLogs(): Promise<void> {
    const ids = Object.values(resourceIds);
    if (ids.length > 0) await database.query(`DELETE FROM totalbase.logs WHERE resource = ANY($1::uuid[])`, [ids]);
  }

  async function dropObjects(): Promise<void> {
    await database.query(`DROP VIEW IF EXISTS public.rat_items_view`);
    await database.query(`DROP TABLE IF EXISTS public.rat_items, public.rat_plain`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await dropObjects();
    await database.query(`CREATE TABLE public.rat_items (id serial PRIMARY KEY, name text NOT NULL, secret text NOT NULL)`);
    await database.query(`CREATE TABLE public.rat_plain (id serial PRIMARY KEY, name text NOT NULL)`);
    await database.query(`CREATE VIEW public.rat_items_view AS SELECT id, name, secret, 100 / (length(name) - 4) AS ratio FROM public.rat_items`);
    await database.query(`INSERT INTO public.rat_items (name, secret) VALUES ('alpha', $1), ('beta', $1), ('gamma', $1)`, [secret]);
    await database.query(`INSERT INTO public.rat_plain (name) VALUES ('one')`);

    resourceIds.items = await register("rat_items", "TABLE", true);
    resourceIds.plain = await register("rat_plain", "TABLE", false);
    resourceIds.view = await register("rat_items_view", "VIEW", true);

    allowRoleId = (await context.roles.create(`${PREFIX}-allow`, { apiAccess: true })).id;
    noGrantRoleId = (await context.roles.create(`${PREFIX}-none`, { apiAccess: true })).id;
    const fields = ["id", "name", "secret", "ratio"].map((field) => ({ field, effect: "ALLOW" as const }));
    for (const id of Object.values(resourceIds)) {
      await context.permissions.set(allowRoleId, id, "READ", { effect: "ALLOW", fields });
    }
    reader = await createTestApiToken(context, { name: `${PREFIX}-reader`, roleId: allowRoleId, email: `${PREFIX}-reader@example.com` });
    stranger = await createTestApiToken(context, { name: `${PREFIX}-stranger`, roleId: noGrantRoleId, email: `${PREFIX}-stranger@example.com` });
  });

  afterAll(async () => {
    await clearLogs();
    for (const id of Object.values(resourceIds)) {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
    }
    for (const user of [reader, stranger]) {
      if (user) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [user.userId]);
    }
    for (const id of [allowRoleId, noGrantRoleId]) {
      if (id) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    }
    await dropObjects();
    await app.close();
  });

  it("a list read writes one READ row with the fields, the filter and the row count - no row data", async () => {
    await clearLogs();
    const res = await get(
      `/api/public/table/rat_items?fields=id,name&where[name][_in]=alpha,beta&count=true&search=a`,
      reader.plainKey,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toHaveLength(2);

    const logs = await logsFor(resourceIds.items!);
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log).toMatchObject({
      action: "READ",
      status: "EXECUTED",
      source: "api",
      principal_type: "API_KEY",
      principal: reader.tokenId,
      fields: ["id", "name"],
      where_clause: { name: { _in: "alpha,beta" } },
      metadata: { rowCount: 2, count: 2, search: "a" },
      payload: null,
      changes: null,
    });
    expect(log["request_id"]).toBeTruthy();
    expect(JSON.stringify(log)).not.toContain("alpha\"");
    expect(JSON.stringify(log)).not.toContain(secret);
  });

  it("a by-key read writes one READ row with the key, found or not", async () => {
    await clearLogs();
    const { rows } = await database.query<{ id: number }>(`SELECT id FROM public.rat_items WHERE name = 'gamma'`);
    const id = String(rows[0]!.id);
    const res = await get(`/api/public/table/rat_items/${id}`, reader.plainKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.secret).toBe(secret);

    const missing = await get(`/api/public/table/rat_items/999999`, reader.plainKey);
    expect(missing.statusCode).toBe(404);

    const logs = await logsFor(resourceIds.items!);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      action: "READ",
      status: "EXECUTED",
      fields: null,
      where_clause: { id: { _eq: id } },
      metadata: { rowCount: 1, pk: id },
      payload: null,
    });
    expect(logs[1]).toMatchObject({ status: "EXECUTED", metadata: { rowCount: 0, pk: "999999" } });
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("a view read writes one READ row", async () => {
    await clearLogs();
    const res = await get(`/api/public/view/rat_items_view?where[name][_eq]=alpha`, reader.plainKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toHaveLength(1);

    const logs = await logsFor(resourceIds.view!);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "READ",
      status: "EXECUTED",
      principal: reader.tokenId,
      fields: null,
      where_clause: { name: { _eq: "alpha" } },
      metadata: { rowCount: 1 },
      payload: null,
    });
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("a resource with audit_read off writes nothing", async () => {
    await clearLogs();
    expect((await get(`/api/public/table/rat_plain`, reader.plainKey)).statusCode).toBe(200);
    const { rows } = await database.query<{ id: number }>(`SELECT id FROM public.rat_plain LIMIT 1`);
    expect((await get(`/api/public/table/rat_plain/${rows[0]!.id}`, reader.plainKey)).statusCode).toBe(200);
    expect(await logsFor(resourceIds.plain!)).toHaveLength(0);
  });

  it("a denied read of an audited resource writes a DENIED row", async () => {
    await clearLogs();
    const res = await get(`/api/public/table/rat_items?where[name][_eq]=alpha`, stranger.plainKey);
    expect(res.statusCode).toBe(403);
    const logs = await logsFor(resourceIds.items!);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: "DENIED",
      principal: stranger.tokenId,
      where_clause: { name: { _eq: "alpha" } },
      error_code: "ACTION_DENIED",
    });

    // audit_read off: a denied read leaves nothing either.
    expect((await get(`/api/public/table/rat_plain`, stranger.plainKey)).statusCode).toBe(403);
    expect(await logsFor(resourceIds.plain!)).toHaveLength(0);
  });

  it("a read whose query fails writes a FAILED row", async () => {
    await clearLogs();
    // 'beta' has four letters: the view's ratio divides by zero (22012) inside the read.
    const res = await get(`/api/public/view/rat_items_view?where[name][_eq]=beta`, reader.plainKey);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const logs = await logsFor(resourceIds.view!);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "FAILED", where_clause: { name: { _eq: "beta" } }, sqlstate: "22012", payload: null });
  });

  it("an audited read whose audit row can't be written fails instead of returning the rows", async () => {
    const original = context.audit.record.bind(context.audit);
    context.audit.record = async (client, entry) => {
      if (entry.action === "READ" && entry.status === "EXECUTED") throw new Error("audit store unavailable");
      return original(client, entry);
    };
    try {
      const res = await get(`/api/public/table/rat_items`, reader.plainKey);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(secret);
      // audit_read off: the read never touches the audit log.
      expect((await get(`/api/public/table/rat_plain`, reader.plainKey)).statusCode).toBe(200);
    } finally {
      context.audit.record = original;
    }
  });
});
