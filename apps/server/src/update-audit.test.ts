import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Specification_Security.md §11.4: an UPDATE records old and new of every
 * column it changed, minus the resource's audit exclusions.
 * The old values come from the UPDATE statement itself (compileUpdate's
 * locked old_rows CTE), on every UPDATE path - by primary key, bulk, by
 * filter and inside a transaction - and never reach the response.
 */
describe("UPDATE audit rows carry old and new values", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let itemsId: string;
  let apiKeyPlain: string;
  let apiKeyUserId: string;
  let apiKeyId: string;

  const ITEMS = "update_audit_test_items";

  function request(method: "POST" | "PATCH", url: string, payload: unknown) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${apiKeyPlain}` }, payload: payload as object });
  }

  async function insertItem(name: string, price: number): Promise<number> {
    const { rows } = await database.query<{ id: number }>(
      `INSERT INTO public.${ITEMS} (name, price) VALUES ($1, $2) RETURNING id`,
      [name, price],
    );
    return rows[0]!.id;
  }

  async function updateLogs(id: number): Promise<{ changes: unknown; payload: Record<string, unknown> }[]> {
    const { rows } = await database.query<{ changes: unknown; payload: Record<string, unknown> }>(
      `SELECT changes, payload FROM totalbase.logs
        WHERE resource = $1 AND action = 'UPDATE' AND status = 'EXECUTED' AND payload ->> 'id' = $2
        ORDER BY started_at, id`,
      [itemsId, String(id)],
    );
    return rows;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(
      `CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, name text, price numeric NOT NULL DEFAULT 0, secret text DEFAULT 'TOP-SECRET')`,
    );
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET", "POST", "PATCH"]],
    );
    itemsId = rows[0]!.id;

    const role = await context.roles.create("update-audit-test-role", { apiAccess: true });
    roleId = role.id;
    const allow = (...fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, itemsId, "READ", { effect: "ALLOW", fields: allow("id", "name", "price") });
    await context.permissions.set(roleId, itemsId, "UPDATE", { effect: "ALLOW", fields: allow("name", "price", "secret") });
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");

    ({ plainKey: apiKeyPlain, userId: apiKeyUserId, tokenId: apiKeyId } = await createTestApiToken(context, {
      name: "update-audit-test-key",
      roleId,
      email: "update-audit-test-key-owner@example.com",
    }));
  });

  beforeEach(async () => {
    await context.auditExclusions.set(itemsId, []);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.audits_exclusions WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [apiKeyId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("PATCH by primary key records, by default, every column that changed with its real old value", async () => {
    const id = await insertItem("before", 10);
    const res = await request("PATCH", `/api/public/table/${ITEMS}/${id}`, { data: { name: "after", price: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id, name: "after", price: "10" });
    expect(res.body).not.toContain("__old");

    const logs = await updateLogs(id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.changes).toEqual({ name: { old: "before", new: "after" } });
    // The outbox event and the audit payload are still the new row, nothing internal.
    expect(Object.keys(logs[0]!.payload).some((key) => key.startsWith("__"))).toBe(false);
    const { rows: outbox } = await database.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM totalbase.outbox WHERE resource = $1 AND event = 'UPDATE' AND payload ->> 'id' = $2`,
      [itemsId, String(id)],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toEqual({ id, name: "after", price: "10", secret: "TOP-SECRET" });
  });

  it("records a column the caller can't READ in the audit, but never returns it", async () => {
    const id = await insertItem("hidden", 1);
    const res = await request("PATCH", `/api/public/table/${ITEMS}/${id}`, { data: { secret: "rotated" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id, name: "hidden", price: "1" });
    expect(res.body).not.toContain("TOP-SECRET");
    expect((await updateLogs(id))[0]!.changes).toEqual({ secret: { old: "TOP-SECRET", new: "rotated" } });
  });

  it("bulk PATCH and PATCH by filter record each row's own old values", async () => {
    const a = await insertItem("bulk-a", 1);
    const b = await insertItem("bulk-b", 2);
    const bulk = await request("PATCH", `/api/public/table/${ITEMS}?bulk=true`, {
      data: [{ id: a, price: 11 }, { id: b, name: "bulk-b2" }],
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.body).not.toContain("__old");
    expect((await updateLogs(a))[0]!.changes).toEqual({ price: { old: "1", new: "11" } });
    expect((await updateLogs(b))[0]!.changes).toEqual({ name: { old: "bulk-b", new: "bulk-b2" } });

    const byFilter = await request("PATCH", `/api/public/table/${ITEMS}?where[id][_in]=${a},${b}`, { data: { price: 50 } });
    expect(byFilter.statusCode).toBe(200);
    expect(byFilter.json().data).toHaveLength(2);
    expect(byFilter.body).not.toContain("__old");
    expect((await updateLogs(a))[1]!.changes).toEqual({ price: { old: "11", new: "50" } });
    expect((await updateLogs(b))[1]!.changes).toEqual({ price: { old: "2", new: "50" } });
  });

  it("an update inside POST /api/transactions records its old values", async () => {
    const id = await insertItem("tx-before", 5);
    const res = await app.inject({
      method: "POST",
      url: "/api/transactions",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: {
        operations: [
          { key: "u", operation: "update", schema: "public", table: ITEMS, id, data: { name: "tx-after", price: 6 } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.u).toEqual({ id, name: "tx-after", price: "6" });
    expect(res.body).not.toContain("__old");
    expect((await updateLogs(id))[0]!.changes).toEqual({
      name: { old: "tx-before", new: "tx-after" },
      price: { old: "5", new: "6" },
    });
  });

  it("keeps an excluded column out of the audit entry - changes and payload - but not out of the outbox event", async () => {
    await context.auditExclusions.set(itemsId, ["secret"]);
    const id = await insertItem("excl", 1);
    const res = await request("PATCH", `/api/public/table/${ITEMS}/${id}`, { data: { name: "excl2", secret: "rotated" } });
    expect(res.statusCode).toBe(200);
    const logs = await updateLogs(id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.changes).toEqual({ name: { old: "excl", new: "excl2" } });
    expect(logs[0]!.payload).toEqual({ id, name: "excl2", price: "1" });
    // A workflow still gets the whole row, before and after, and exactly what changed.
    const { rows: outbox } = await database.query<{ payload: Record<string, unknown>; old_payload: Record<string, unknown>; changed_columns: string[] }>(
      `SELECT payload, old_payload, changed_columns FROM totalbase.outbox WHERE resource = $1 AND event = 'UPDATE' AND payload ->> 'id' = $2`,
      [itemsId, String(id)],
    );
    expect(outbox[0]!.payload).toMatchObject({ name: "excl2", secret: "rotated" });
    expect(outbox[0]!.old_payload).toEqual({ id, name: "excl", price: "1", secret: "TOP-SECRET" });
    expect([...outbox[0]!.changed_columns].sort()).toEqual(["name", "secret"]);
  });

  it("records no changes when an update changes nothing", async () => {
    const id = await insertItem("same", 1);
    const res = await request("PATCH", `/api/public/table/${ITEMS}/${id}`, { data: { name: "same" } });
    expect(res.statusCode).toBe(200);
    expect((await updateLogs(id))[0]!.changes).toBeNull();
  });
});
