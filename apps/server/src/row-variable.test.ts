import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * $ROW.<column> (Specification_Data_API.md §3.7, T68): a filter compares a column against another column of the same
 * row - in a request's where, and in a permission's row filter, where a write is checked against the resulting row.
 */
describe("$ROW.<column> - comparing two columns of the same row", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let productsId: string;
  let token: string;
  let userId: string;
  let tokenId: string;

  const PRODUCTS = "row_variable_test_products";
  const get = (query: string) => app.inject({ method: "GET", url: `/api/public/table/${PRODUCTS}?${query}`, headers: { authorization: `Bearer ${token}` } });
  const patch = (id: number, data: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/public/table/${PRODUCTS}/${id}`, headers: { authorization: `Bearer ${token}` }, payload: { data } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${PRODUCTS} CASCADE`);
    await database.query(`CREATE TABLE public.${PRODUCTS} (id serial PRIMARY KEY, name text, stock int NOT NULL, stock_minimo int NOT NULL, total numeric NOT NULL DEFAULT 0, pagado numeric NOT NULL DEFAULT 0, secret int NOT NULL DEFAULT 0)`);
    await database.query(`INSERT INTO public.${PRODUCTS} (name, stock, stock_minimo, total, pagado) VALUES ('low', 2, 5, 100, 40), ('ok', 9, 5, 100, 100), ('edge', 5, 5, 50, 0)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${PRODUCTS}`, PRODUCTS, ["GET", "PATCH"]],
    );
    productsId = rows[0]!.id;
    roleId = (await context.roles.create("row-variable-test-role", { apiAccess: true })).id;
    // Every column but `secret`; an update may never leave a product paid past its total.
    const fields = ["id", "name", "stock", "stock_minimo", "total", "pagado"].map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, productsId, "READ", { effect: "ALLOW", fields });
    await context.permissions.set(roleId, productsId, "UPDATE", { effect: "ALLOW", fields, where: { pagado: { _lte: "$ROW.total" } } });
    ({ plainKey: token, userId, tokenId } = await createTestApiToken(context, { name: "row-variable-test-key", roleId, email: "row-variable-test-owner@example.com" }));
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [productsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [productsId]);
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [tokenId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [productsId]);
    await database.query(`DROP TABLE IF EXISTS public.${PRODUCTS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("filters a read by another column of the same row", async () => {
    const below = await get("fields=name&order_by=name&where[stock][_lt]=$ROW.stock_minimo");
    expect(below.statusCode).toBe(200);
    expect(below.json().data).toEqual([{ name: "low" }]);
    const partial = await get("fields=name&order_by=name&where[pagado][_lt]=$ROW.total");
    expect(partial.json().data.map((r: { name: string }) => r.name)).toEqual(["edge", "low"]);
  });

  it("refuses a related column, and a column the viewer may not read", async () => {
    expect((await get("where[stock][_lt]=$ROW.categoria.minimo")).statusCode).toBe(400);
    // Two kinds that don't compare: said plainly, never PostgreSQL's operator error (M28).
    const kinds = await get("where[stock][_lt]=$ROW.name");
    expect(kinds.statusCode).toBe(400);
    expect(kinds.json().errors[0].message).toBe("$ROW.name is text and the column it is compared with is integer - $ROW names a column of the same kind (a number with a number, a date with a date).");
    // `secret` isn't granted: comparing against it would reveal it.
    const hidden = await get("where[stock][_lt]=$ROW.secret");
    expect(hidden.statusCode).toBeGreaterThanOrEqual(400);
    expect(hidden.statusCode).toBeLessThan(500);
  });

  // flags (Specification_Data_API.md §3.9, T67): which named filters each row meets - in meta.flags, rows untouched.
  it("answers which flags each row meets, without filtering the rows", async () => {
    const res = await get("fields=name&order_by=name&flags[bajo][stock][_lt]=$ROW.stock_minimo&flags[pagada][pagado][_gte]=$ROW.total&count=true");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([{ name: "edge" }, { name: "low" }, { name: "ok" }]);
    expect(body.meta.flags).toEqual([[], ["bajo"], ["pagada"]]);
    expect(body.meta.count).toBe(3);
    // A flag over a column the caller may not read is refused, as a where would be.
    expect((await get("flags[x][secret][_gt]=0")).statusCode).toBeGreaterThanOrEqual(400);
    // A grouped read has no rows to flag.
    expect((await get("group_by=name&_count[*]=n&flags[x][stock][_gt]=0")).statusCode).toBe(400);
  });

  it("checks a permission's row filter against the resulting row of an update", async () => {
    const { rows } = await database.query<{ id: number }>(`SELECT id FROM public.${PRODUCTS} WHERE name = 'low'`);
    const id = rows[0]!.id;
    expect((await patch(id, { pagado: 90 })).statusCode).toBe(200);
    // Paid past its total: the resulting row leaves the grant - refused, nothing written.
    const over = await patch(id, { pagado: 150 });
    expect(over.statusCode).toBe(403);
    expect((await database.query(`SELECT pagado FROM public.${PRODUCTS} WHERE id = $1`, [id])).rows[0]).toEqual({ pagado: "90" });
    // Raising the total in the same write lets it.
    expect((await patch(id, { pagado: 150, total: 200 })).statusCode).toBe(200);
  });
});
