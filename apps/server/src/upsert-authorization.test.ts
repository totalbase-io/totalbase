import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Regression (security defect): a CREATE with `on_conflict` action UPDATE
 * that lands on an existing row is an UPDATE (Specification_Data_API.md §5.7,
 * Specification_Security.md §6.6) - it needs the UPDATE grant, the UPDATE row
 * filter on the OLD row (the DO UPDATE's own WHERE) and on the NEW row, the
 * UPDATE field decisions for the fields it sets and the UPDATE payload checks,
 * and it is audited and published as an UPDATE. Before the fix it was
 * authorized and audited as a CREATE, so a role with CREATE but no UPDATE could
 * overwrite existing rows by upserting on a unique key.
 */
describe("ON CONFLICT DO UPDATE is authorized and audited as an UPDATE", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let itemsId: string;
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const tokenIds: string[] = [];
  let createOnlyKey: string;
  let writerKey: string;

  const ITEMS = "upsert_auth_test_items";
  const URL = `/api/public/table/${ITEMS}`;

  function post(key: string, payload: unknown, bulk = false) {
    return app.inject({
      method: "POST",
      url: bulk ? `${URL}?bulk=true` : URL,
      headers: { authorization: `Bearer ${key}` },
      payload: payload as object,
    });
  }

  async function seed(sku: string, name: string, branch: number, price = 10): Promise<number> {
    const { rows } = await database.query<{ id: number }>(
      `INSERT INTO public.${ITEMS} (sku, name, price, branch) VALUES ($1, $2, $3, $4) RETURNING id`,
      [sku, name, price, branch],
    );
    return rows[0]!.id;
  }

  async function row(id: number) {
    const { rows } = await database.query<{ sku: string; name: string; price: string; branch: number }>(
      `SELECT sku, name, price, branch FROM public.${ITEMS} WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function logs(sku: string) {
    const { rows } = await database.query<{ action: string; changes: unknown }>(
      `SELECT action, changes FROM totalbase.logs
        WHERE resource = $1 AND status = 'EXECUTED' AND payload ->> 'sku' = $2 ORDER BY started_at, id`,
      [itemsId, sku],
    );
    return rows;
  }

  async function outbox(sku: string): Promise<string[]> {
    const { rows } = await database.query<{ event: string }>(
      `SELECT event FROM totalbase.outbox WHERE resource = $1 AND payload ->> 'sku' = $2 ORDER BY created_at, id`,
      [itemsId, sku],
    );
    return rows.map((r) => r.event);
  }

  const upsert = (data: Record<string, unknown>, set: Record<string, unknown>) => ({
    data,
    on_conflict: { target: ["sku"], action: "UPDATE", data: set },
  });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(
      `CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, sku text NOT NULL UNIQUE, name text, price numeric NOT NULL DEFAULT 0, branch int NOT NULL DEFAULT 1)`,
    );
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET", "POST", "PATCH"]],
    );
    itemsId = rows[0]!.id;
    const allow = (...fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));

    // CREATE (every column) but no UPDATE grant at all.
    const createOnly = (await context.roles.create("upsert-auth-test-create-only", { apiAccess: true })).id;
    roleIds.push(createOnly);
    await context.permissions.set(createOnly, itemsId, "READ", { effect: "ALLOW", fields: allow("id", "sku", "name", "price", "branch") });
    await context.permissions.set(createOnly, itemsId, "CREATE", { effect: "ALLOW", fields: allow("sku", "name", "price", "branch") });

    // CREATE every column; UPDATE only branch 1 rows, only name/branch, and never naming a row "bad".
    const writer = (await context.roles.create("upsert-auth-test-writer", { apiAccess: true })).id;
    roleIds.push(writer);
    await context.permissions.set(writer, itemsId, "READ", { effect: "ALLOW", fields: allow("id", "sku", "name", "price", "branch") });
    await context.permissions.set(writer, itemsId, "CREATE", { effect: "ALLOW", fields: allow("sku", "name", "price", "branch") });
    await context.permissions.set(writer, itemsId, "UPDATE", {
      effect: "ALLOW",
      where: { branch: { _eq: "1" } },
      fields: allow("name", "branch"),
      payloadChecks: [{ rule: { name: { _neq: "bad" } }, label: "An update may not name a row bad." }],
    });

    for (const [name, roleId] of [["create-only", createOnly], ["writer", writer]] as const) {
      const token = await createTestApiToken(context, { name: `upsert-auth-test-${name}`, roleId, email: `upsert-auth-test-${name}@example.com` });
      userIds.push(token.userId);
      tokenIds.push(token.tokenId);
      if (name === "create-only") createOnlyKey = token.plainKey;
      else writerKey = token.plainKey;
    }
  });

  beforeEach(async () => {
    await context.auditExclusions.set(itemsId, []);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.audits_exclusions WHERE resource = $1`, [itemsId]);
    for (const id of tokenIds) await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [id]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of roleIds) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("a role with CREATE but no UPDATE cannot update through on_conflict (403, row unchanged)", async () => {
    const id = await seed("co-1", "original", 1);
    const res = await post(createOnlyKey, upsert({ sku: "co-1", name: "hijacked", price: 999 }, { name: "$INSERT.name", price: "$INSERT.price" }));
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("ACTION_DENIED");
    expect(await row(id)).toMatchObject({ name: "original", price: "10" });
    expect(await outbox("co-1")).toEqual([]);

    // Refused before any SQL: not even a new row is inserted.
    const fresh = await post(createOnlyKey, upsert({ sku: "co-new", name: "x" }, { name: "$INSERT.name" }));
    expect(fresh.statusCode).toBe(403);
    expect((await database.query(`SELECT 1 FROM public.${ITEMS} WHERE sku = 'co-new'`)).rows).toHaveLength(0);
  });

  it("DO NOTHING is unchanged: CREATE alone suffices and an existing row is skipped", async () => {
    const id = await seed("dn-1", "original", 1);
    const res = await post(createOnlyKey, { data: { sku: "dn-1", name: "other" }, on_conflict: { target: ["sku"], action: "NOTHING" } });
    // One shape whatever happened (Specification_Data_API.md §5.7): 201, `data: null` for the skipped row.
    expect([res.statusCode, res.json()]).toEqual([201, { data: null }]);
    expect(await row(id)).toMatchObject({ name: "original" });
    expect(await logs("dn-1")).toEqual([]);

    const inserted = await post(createOnlyKey, { data: { sku: "dn-2", name: "new" }, on_conflict: { target: ["sku"], action: "NOTHING" } });
    expect(inserted.statusCode).toBe(201);
    expect(inserted.json().data).toMatchObject({ sku: "dn-2", name: "new" });
    expect((await logs("dn-2")).map((l) => l.action)).toEqual(["CREATE"]);
  });

  it("DO NOTHING in bulk answers one entry per item, in order - null where the item was skipped", async () => {
    await seed("dnb-1", "original", 1);
    const res = await post(createOnlyKey, {
      data: [{ sku: "dnb-1", name: "other" }, { sku: "dnb-2", name: "new" }],
      on_conflict: { target: ["sku"], action: "NOTHING" },
    }, true);
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data;
    expect(data).toHaveLength(2);
    expect(data[0]).toBeNull();
    expect(data[1]).toMatchObject({ sku: "dnb-2", name: "new" });
  });

  it("an existing row outside the UPDATE row filter (OLD) is left untouched: 403", async () => {
    const id = await seed("rf-1", "other branch", 2);
    const res = await post(writerKey, upsert({ sku: "rf-1", name: "hijacked" }, { name: "$INSERT.name" }));
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().errors[0].code).toBe("ACTION_DENIED");
    expect(await row(id)).toMatchObject({ name: "other branch", branch: 2 });
    expect(await outbox("rf-1")).toEqual([]);
  });

  it("an update whose resulting row leaves the UPDATE row filter (NEW) is rolled back: 403", async () => {
    const id = await seed("nf-1", "mine", 1);
    const res = await post(writerKey, upsert({ sku: "nf-1", name: "mine" }, { branch: 2 }));
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("ACTION_DENIED");
    expect(await row(id)).toMatchObject({ branch: 1 });
  });

  it("a field allowed for CREATE but not for UPDATE cannot be overwritten through the conflict branch", async () => {
    const id = await seed("fd-1", "priced", 1, 10);
    const res = await post(writerKey, upsert({ sku: "fd-1", price: 1 }, { price: "$INSERT.price" }));
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("FIELD_PERMISSION_DENIED");
    expect(await row(id)).toMatchObject({ price: "10" });
  });

  it("UPDATE payload checks apply to an updated row, not to an inserted one", async () => {
    const id = await seed("pc-1", "good", 1);
    const refused = await post(writerKey, upsert({ sku: "pc-1", name: "bad" }, { name: "$INSERT.name" }));
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors[0].code).toBe("PAYLOAD_CHECK_FAILED");
    expect(await row(id)).toMatchObject({ name: "good" });

    const inserted = await post(writerKey, upsert({ sku: "pc-2", name: "bad" }, { name: "$INSERT.name" }));
    expect(inserted.statusCode).toBe(201);
    expect(inserted.json().data).toMatchObject({ sku: "pc-2", name: "bad" });
  });

  it("an allowed upsert that updates is audited and published as UPDATE (old/new), one that inserts as CREATE", async () => {
    const id = await seed("au-1", "before", 1);
    const updated = await post(writerKey, upsert({ sku: "au-1", name: "after", price: 5 }, { name: "$INSERT.name" }));
    expect(updated.statusCode, updated.body).toBe(201);
    expect(updated.json().data).toEqual({ id, sku: "au-1", name: "after", price: "10", branch: 1 });
    expect(updated.body).not.toContain("__");
    expect(await logs("au-1")).toEqual([{ action: "UPDATE", changes: { name: { old: "before", new: "after" } } }]);
    expect(await outbox("au-1")).toEqual(["UPDATE"]);

    const inserted = await post(writerKey, upsert({ sku: "au-2", name: "fresh" }, { name: "$INSERT.name" }));
    expect(inserted.statusCode).toBe(201);
    // A CREATE's entry holds the row in `payload`; `changes` is an UPDATE's.
    expect(await logs("au-2")).toEqual([{ action: "CREATE", changes: null }]);
    expect(await outbox("au-2")).toEqual(["CREATE"]);
  });

  it("a bulk upsert takes each row's own branch, and one refused row rolls back the batch", async () => {
    const id = await seed("bk-1", "existing", 1);
    const mixed = await post(
      writerKey,
      upsert([{ sku: "bk-1", name: "updated" }, { sku: "bk-2", name: "inserted" }] as unknown as Record<string, unknown>, { name: "$INSERT.name" }),
      true,
    );
    expect(mixed.statusCode).toBe(201);
    expect(mixed.json().data.map((r: { name: string }) => r.name)).toEqual(["updated", "inserted"]);
    expect((await logs("bk-1")).map((l) => l.action)).toEqual(["UPDATE"]);
    expect((await logs("bk-2")).map((l) => l.action)).toEqual(["CREATE"]);
    expect(await row(id)).toMatchObject({ name: "updated" });

    const other = await seed("bk-3", "other branch", 2);
    const refused = await post(
      writerKey,
      upsert([{ sku: "bk-4", name: "would insert" }, { sku: "bk-3", name: "hijacked" }] as unknown as Record<string, unknown>, { name: "$INSERT.name" }),
      true,
    );
    expect(refused.statusCode).toBe(403);
    expect(await row(other)).toMatchObject({ name: "other branch" });
    expect((await database.query(`SELECT 1 FROM public.${ITEMS} WHERE sku = 'bk-4'`)).rows).toHaveLength(0);
  });
});

/**
 * Regression (security defect): the TotalBase guardrails ran on the INSERT
 * payload only, never on `on_conflict.data` - a non-administrator with
 * CREATE/UPDATE on roles turned on app_access of an existing role
 * through the conflict branch. The DO UPDATE branch now passes the same
 * guardrails a plain UPDATE does (Specification_Security.md §10.2): the
 * protected columns it sets, and role ownership on the row it updated.
 */
describe("ON CONFLICT DO UPDATE on roles passes the UPDATE guardrails", () => {
  const P = "upsert-guardrail";
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let rolesResourceId: string;
  let previousExposure: string[];
  let callerRoleId: string;
  let ownRoleId: string;
  let otherRoleId: string;
  let token: { plainKey: string; tokenId: string; userId: string };

  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/totalbase/table/roles",
      headers: { authorization: `Bearer ${token.plainKey}` },
      payload: payload as object,
    });
  const roleRow = async (id: string) =>
    (await database.query<{ name: string; app_access: boolean; api_access: boolean }>(
      `SELECT name, app_access, api_access FROM totalbase.roles WHERE id = $1`,
      [id],
    )).rows[0];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    rolesResourceId = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'roles'`,
    )).rows[0]!.id;
    previousExposure = (await database.query<{ exposed_methods: string[] }>(
      `SELECT exposed_methods FROM totalbase.resources WHERE id = $1`,
      [rolesResourceId],
    )).rows[0]!.exposed_methods;
    await database.query(`UPDATE totalbase.resources SET exposed_methods = ARRAY['GET', 'POST', 'PATCH'] WHERE id = $1`, [rolesResourceId]);

    callerRoleId = (await context.roles.create(`${P}-caller`, { apiAccess: true })).id;
    // Deliberately over-permissive: the guardrail, not the grant, must stop it.
    const fields = ["id", "name", "app_access", "api_access"].map((field) => ({ field, effect: "ALLOW" as const }));
    for (const action of ["READ", "CREATE", "UPDATE"] as const) {
      await context.permissions.set(callerRoleId, rolesResourceId, action, { effect: "ALLOW", fields });
    }
    token = await createTestApiToken(context, { name: `${P}-key`, roleId: callerRoleId, email: `${P}-owner@example.com` });
    ownRoleId = (await database.query<{ id: string }>(
      // created_by is set by a trigger from the acting user (totalbase.actor_user_id).
      `WITH actor AS (SELECT set_config('totalbase.actor_user_id', $2, true))
       INSERT INTO totalbase.roles (name, app_access) SELECT $1, false FROM actor RETURNING id`,
      [`${P}-own`, token.userId],
    )).rows[0]!.id;
    otherRoleId = (await context.roles.create(`${P}-other`, { appAccess: false })).id;
  });

  afterAll(async () => {
    await database.query(`UPDATE totalbase.resources SET exposed_methods = $2 WHERE id = $1`, [rolesResourceId, previousExposure]);
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [token.tokenId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [token.userId]);
    for (const id of [ownRoleId, otherRoleId, callerRoleId]) {
      await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [id]);
      await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    }
    await app.close();
    await database.close();
  });

  it("refuses an access flag in on_conflict.data (403 PERMISSION_DENIED, row unchanged)", async () => {
    const before = await roleRow(ownRoleId);
    for (const data of [{ app_access: true }, { api_access: "$INSERT.api_access" }]) {
      const res = await post({
        data: { id: ownRoleId, name: `${P}-own`, api_access: true },
        on_conflict: { target: ["id"], action: "UPDATE", data },
      });
      expect([res.statusCode, res.json().errors?.[0]?.code], res.body).toEqual([403, "PERMISSION_DENIED"]);
    }
    expect(await roleRow(ownRoleId)).toEqual(before);
  });

  it("applies role ownership to the row the conflict updated", async () => {
    const res = await post({ data: { id: otherRoleId, name: `${P}-other` }, on_conflict: { target: ["id"], action: "UPDATE", data: { name: `${P}-renamed` } } });
    expect([res.statusCode, res.json().errors?.[0]?.code], res.body).toEqual([403, "PERMISSION_DENIED"]);
    expect((await roleRow(otherRoleId))!.name).toBe(`${P}-other`);

    const own = await post({ data: { id: ownRoleId, name: `${P}-own` }, on_conflict: { target: ["id"], action: "UPDATE", data: { name: `${P}-own2` } } });
    expect(own.statusCode, own.body).toBe(201);
    expect((await roleRow(ownRoleId))!.name).toBe(`${P}-own2`);
  });
});
