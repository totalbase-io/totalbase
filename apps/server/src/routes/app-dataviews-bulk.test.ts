import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { cleanupTracked, setupTestApp, track, uniqueSuffix } from "../test-support.js";

const PREFIX = `dv-bulk-${uniqueSuffix()}`;
const PASSWORD = "a-strong-enough-password";
const TABLE = "dv_bulk_test_invoices";

/**
 * Bulk edit (Specification_DataViews.md §5.15, T74): only the rows the viewer chose, by their keys - never a set named
 * by a filter or a search - all or nothing, within the save's cap.
 */
describe("POST /app/api/dataviews/:slug/bulk-update", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  let viewId: string;
  let slug: string;

  const bulk = (data: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/app/api/dataviews/${slug}/bulk-update`, headers: { authorization: `Bearer ${token}` }, payload: { data } });
  const notes = async () => (await database.query<{ numero: number; nota: string | null }>(`SELECT numero, nota FROM public.${TABLE} ORDER BY numero`)).rows;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero int NOT NULL, lote text, nota text CHECK (nota IS DISTINCT FROM 'prohibida'))`);
    const { rows: [resource] } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.${TABLE}')::oid, 'public', '${TABLE}', 'TABLE', 'ACTIVE', ARRAY['GET','PATCH']) RETURNING id`,
    );
    track("resources", resource!.id);
    const role = track("roles", (await context.roles.create(`${PREFIX}-clerk`, { appAccess: true })).id);
    const fields = ["id", "numero", "lote", "nota"].map((field) => ({ field, effect: "ALLOW" as const }));
    // Rows numbered over 100 are outside this viewer's filter.
    const mine = { numero: { _lte: "100" } };
    await context.permissions.set(role, resource!.id, "READ", { effect: "ALLOW", fields });
    await context.permissions.set(role, resource!.id, "UPDATE", { effect: "ALLOW", fields, where: mine });
    const view = await context.dataviewsAdmin.create({ name: `${PREFIX} invoices`, slug: `${PREFIX}-invoices`, sourceResourceId: resource!.id, viewType: "TABLE" });
    viewId = track("dataviews", view.id);
    slug = view.slug;
    await context.dataviewsAdmin.setRoles(viewId, [role]);
    await context.dataviewsAdmin.publish(viewId, null);
    const user = await context.auth.users.create({ email: `${PREFIX}@example.com`, name: "Clerk", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    track("users", user.id);
    await context.roleAssignments.assignRoleToUser(user.id, role);
    token = (await context.auth.login({ email: `${PREFIX}@example.com`, password: PASSWORD })).token;
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM public.${TABLE}`);
    await database.query(`INSERT INTO public.${TABLE} (numero, lote) VALUES (1, 'Lote T74'), (2, 'Lote T74'), (3, 'Otro'), (4, NULL), (101, 'Lote T74')`);
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await app.close();
  });

  const keysOf = async (numeros: number[]) =>
    (await database.query<{ id: string }>(`SELECT id FROM public.${TABLE} WHERE numero = ANY($1) ORDER BY numero`, [numeros])).rows.map((r) => r.id);

  it("writes exactly the rows chosen, by their keys - from any page", async () => {
    const res = await bulk({ set: { nota: "revisada" }, keys: await keysOf([1, 4]) });
    expect(res.json()).toEqual({ data: { updated: 2 } });
    expect((await notes()).map((r) => r.nota)).toEqual(["revisada", null, null, "revisada", null]);
  });

  it("refuses a set named by a filter or a search - only the chosen rows' keys", async () => {
    for (const data of [{ set: { nota: "x" }, query: "search=Lote" }, { set: { nota: "x" }, query: "where[numero][_lte]=3", keys: await keysOf([1]) }, { set: { nota: "x" }, keys: [] }]) {
      const res = await bulk(data);
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("INVALID_QUERY");
    }
    expect((await notes()).every((r) => r.nota === null)).toBe(true);
  });

  it("is all or nothing - a row outside the viewer's filter, one gone, or a CHECK, and none changes", async () => {
    const outside = await bulk({ set: { nota: "revisada" }, keys: await keysOf([1, 2, 101]) });
    expect(outside.statusCode).toBe(404);
    const gone = await bulk({ set: { nota: "revisada" }, keys: [...(await keysOf([1])), "00000000-0000-0000-0000-000000000000"] });
    expect(gone.statusCode).toBe(404);
    const check = await bulk({ set: { nota: "prohibida" }, keys: await keysOf([1, 2]) });
    expect(check.json().errors[0].code).toBe("CHECK_VIOLATION");
    expect((await notes()).every((r) => r.nota === null)).toBe(true);
  });

  it("refuses more rows than dataviews.bulk_edit_max_rows, and a DataView that doesn't let its viewers edit", async () => {
    await context.settings.set("dataviews.bulk_edit_max_rows", 2);
    try {
      const res = await bulk({ set: { nota: "x" }, keys: await keysOf([1, 2, 3]) });
      expect(res.json().errors[0].code).toBe("BULK_EDIT_TOO_MANY");
    } finally {
      await context.settings.reset("dataviews.bulk_edit_max_rows");
    }
    await context.dataviewsAdmin.update(viewId, { viewConfig: { allow: ["create", "delete"] } });
    await context.dataviewsAdmin.publish(viewId, null);
    try {
      expect((await bulk({ set: { nota: "x" }, keys: await keysOf([1]) })).statusCode).toBe(403);
    } finally {
      await context.dataviewsAdmin.update(viewId, { viewConfig: { allow: null } });
      await context.dataviewsAdmin.publish(viewId, null);
    }
    expect((await notes()).every((r) => r.nota === null)).toBe(true);
  });

  it("is capped at 100 at most - the largest page a grid offers", async () => {
    await expect(context.settings.set("dataviews.bulk_edit_max_rows", 101)).rejects.toBeTruthy();
  });
});
