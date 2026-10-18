import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

const PREFIX = "dv-save-test";
const PASSWORD = "a-strong-enough-password";

/**
 * A record and its lines saved together (Specification_DataViews.md §6.6, T51): one transaction through the
 * DataView, its own tables only, each write under the viewer's permissions - no TRANSACTIONS capability.
 */
describe("POST /app/api/dataviews/:slug/save", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  let readOnlyToken: string;
  let slug: string;
  let orders: string;
  let lines: string;
  let masterId: string;
  let grantedRoles: string[];

  const save = (operations: unknown[], as = token) =>
    app.inject({ method: "POST", url: `/app/api/dataviews/${slug}/save`, headers: { authorization: `Bearer ${as}` }, payload: { data: { operations } } });
  const count = async (table: string) => (await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0]!.n;

  async function table(name: string, ddl: string): Promise<string> {
    await database.query(`DROP TABLE IF EXISTS public.${name} CASCADE`);
    await database.query(ddl);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET','POST','PATCH','DELETE']) RETURNING id`,
      [`public.${name}`, name],
    );
    return rows[0]!.id;
  }

  async function viewer(email: string, roleId: string): Promise<string> {
    const user = await context.auth.users.create({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return (await context.auth.login({ email, password: PASSWORD })).token;
  }

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.dataviews_fields WHERE related_dataview IN (SELECT id FROM totalbase.dataviews WHERE slug LIKE '${PREFIX}%')`);
    await database.query(`DELETE FROM totalbase.dataviews WHERE slug LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.resources WHERE name LIKE 'dv_save_test_%'`);
    await database.query(`DROP TABLE IF EXISTS public.dv_save_test_lines, public.dv_save_test_orders, public.dv_save_test_other CASCADE`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    orders = await table("dv_save_test_orders", `CREATE TABLE public.dv_save_test_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer text NOT NULL)`);
    lines = await table(
      "dv_save_test_lines",
      `CREATE TABLE public.dv_save_test_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         "order" uuid NOT NULL REFERENCES public.dv_save_test_orders (id), product text NOT NULL, quantity integer NOT NULL CHECK (quantity > 0))`,
    );
    const other = await table("dv_save_test_other", `CREATE TABLE public.dv_save_test_other (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text)`);

    const role = (await context.roles.create(`${PREFIX}-clerk`, { appAccess: true })).id;
    const readOnly = (await context.roles.create(`${PREFIX}-reader`, { appAccess: true })).id;
    // Every column, each write: a grant names the fields it opens.
    const fields = (names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));
    const columns = { [orders]: fields(["id", "customer"]), [lines]: fields(["id", "order", "product", "quantity"]), [other]: fields(["id", "note"]) };
    for (const action of ["READ", "CREATE", "UPDATE", "DELETE"] as const) {
      for (const resource of [orders, lines, other]) {
        await context.permissions.set(role, resource, action, { effect: "ALLOW", ...(action === "DELETE" ? {} : { fields: columns[resource] }) });
      }
    }
    await context.permissions.set(readOnly, orders, "READ", { effect: "ALLOW", fields: columns[orders] });
    await context.permissions.set(readOnly, orders, "CREATE", { effect: "ALLOW", fields: columns[orders] });
    await context.permissions.set(readOnly, lines, "READ", { effect: "ALLOW", fields: columns[lines] });

    const detail = await context.dataviewsAdmin.create({ name: "Save lines", slug: `${PREFIX}-lines`, sourceResourceId: lines, viewType: "TABLE" });
    const master = await context.dataviewsAdmin.create({ name: "Save orders", slug: `${PREFIX}-orders`, sourceResourceId: orders, viewType: "TABLE" });
    await context.dataviewsAdmin.addWidget(master.id, { widget: "TDataView", config: { props: { dataview: detail.id, column: "order" } } });
    for (const id of [detail.id, master.id]) {
      await context.dataviewsAdmin.setRoles(id, [role, readOnly]);
      await context.dataviewsAdmin.publish(id, null);
    }
    slug = master.slug;
    masterId = master.id;
    grantedRoles = [role, readOnly];
    token = await viewer(`${PREFIX}-clerk@example.com`, role);
    readOnlyToken = await viewer(`${PREFIX}-reader@example.com`, readOnly);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("saves the header and its lines in one go, a line taking the new header's id - no TRANSACTIONS capability", async () => {
    const res = await save([
      { key: "header", operation: "insert", schema: "public", table: "dv_save_test_orders", data: { customer: "Acme" } },
      { key: "line1", operation: "insert", schema: "public", table: "dv_save_test_lines", data: { order: "$header.id", product: "Bolts", quantity: 3 } },
      { key: "line2", operation: "insert", schema: "public", table: "dv_save_test_lines", data: { order: "$header.id", product: "Nuts", quantity: 5 } },
    ]);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.line1.order).toBe(data.header.id);
    expect(await count("dv_save_test_lines")).toBe(2);

    // Changed and removed lines, in the same save as the header's change.
    const changed = await save([
      { key: "header", operation: "update", schema: "public", table: "dv_save_test_orders", id: data.header.id, data: { customer: "Acme SA" } },
      { key: "line1", operation: "update", schema: "public", table: "dv_save_test_lines", id: data.line1.id, data: { quantity: 4 } },
      { key: "line2", operation: "delete", schema: "public", table: "dv_save_test_lines", id: data.line2.id },
    ]);
    expect(changed.statusCode).toBe(200);
    expect(await count("dv_save_test_lines")).toBe(1);
  });

  it("is all or nothing: a line PostgreSQL refuses takes the header with it", async () => {
    const before = await count("dv_save_test_orders");
    const res = await save([
      { key: "header", operation: "insert", schema: "public", table: "dv_save_test_orders", data: { customer: "Beta" } },
      { key: "line1", operation: "insert", schema: "public", table: "dv_save_test_lines", data: { order: "$header.id", product: "Bolts", quantity: 0 } },
    ]);
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].code).toBe("CHECK_VIOLATION");
    // Which line PostgreSQL refused: a form marks that one.
    expect(res.json().errors[0].operation).toBe("line1");
    expect(await count("dv_save_test_orders")).toBe(before);
  });

  it("writes only the DataView's own tables", async () => {
    const res = await save([{ key: "x", operation: "insert", schema: "public", table: "dv_save_test_other", data: { note: "nope" } }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe("INVALID_TRANSACTION_PAYLOAD");
    expect(await count("dv_save_test_other")).toBe(0);
  });

  it("is all or nothing for many rows too - one outside the viewer's row filter refuses the whole save (bulk edit, T74)", async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO public.dv_save_test_orders (customer) VALUES ('Mine 1'), ('Mine 2'), ('Theirs') RETURNING id`,
    );
    const role = (await context.roles.create(`${PREFIX}-filtered`, { appAccess: true })).id;
    const columns = [{ field: "id", effect: "ALLOW" as const }, { field: "customer", effect: "ALLOW" as const }];
    const mine = { customer: { _like: "Mine%" } };
    await context.permissions.set(role, orders, "READ", { effect: "ALLOW", fields: columns, where: mine });
    await context.permissions.set(role, orders, "UPDATE", { effect: "ALLOW", fields: columns, where: mine });
    await context.permissions.set(role, lines, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }] });
    await context.dataviewsAdmin.setRoles(masterId, [...grantedRoles, role]);
    const filtered = await viewer(`${PREFIX}-filtered@example.com`, role);
    const res = await save(rows.map((row, index) => ({ key: `row${index + 1}`, operation: "update", schema: "public", table: "dv_save_test_orders", id: row.id, data: { customer: "Mine renamed" } })), filtered);
    expect(res.statusCode).toBe(404);
    const { rows: after } = await database.query<{ customer: string }>(`SELECT customer FROM public.dv_save_test_orders WHERE id = ANY($1) ORDER BY customer`, [rows.map((r) => r.id)]);
    expect(after.map((r) => r.customer)).toEqual(["Mine 1", "Mine 2", "Theirs"]);
  });

  it("authorizes every write as the viewer's own - a line they can't create refuses the whole save", async () => {
    const before = await count("dv_save_test_orders");
    const res = await save([
      { key: "header", operation: "insert", schema: "public", table: "dv_save_test_orders", data: { customer: "Gamma" } },
      { key: "line1", operation: "insert", schema: "public", table: "dv_save_test_lines", data: { order: "$header.id", product: "Bolts", quantity: 1 } },
    ], readOnlyToken);
    expect(res.statusCode).toBe(403);
    expect(await count("dv_save_test_orders")).toBe(before);
  });
});
