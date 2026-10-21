import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const TABLE = "admin_resources_route_test";

/**
 * A column's presentation over HTTP (DataViews.md §15):
 * administrators only, the body is all of it, and a value its
 * type doesn't take is refused. Validation and storage are covered against
 * PostgreSQL in packages/resources/src/column-presentation.test.ts.
 */
describe("admin resource column routes", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let adminToken: string;
  let resourceId: string;

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await context.database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await context.database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, total numeric(12,2), nota text)`);
    const { rows } = await context.database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [`public.${TABLE}`, TABLE],
    );
    resourceId = rows[0]!.id;
  });

  afterAll(async () => {
    await context.database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await context.database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await app.close();
  });

  function put(column: string, presentation: unknown, token: string | null = adminToken) {
    return app.inject({
      method: "PUT",
      url: `/admin/api/resources/${resourceId}/columns/${column}/presentation`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { data: { presentation } },
    });
  }

  it("needs an administrator", async () => {
    expect((await put("total", { label: "Total" }, null)).statusCode).toBe(401);
  });

  it("sets a column's presentation and lists it", async () => {
    const res = await put("total", { label: "Total", displayFormat: "CURRENCY:ARS" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ columnName: "total", presentation: { label: "Total", displayFormat: "CURRENCY:ARS" } });

    const list = await app.inject({ method: "GET", url: `/admin/api/resources/${resourceId}/columns`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(list.json().data).toContainEqual(expect.objectContaining(res.json().data));
  });

  it("Add Column stores the presentation it sends, and a bad one leaves no column behind", async () => {
    const add = (name: string, config: unknown) => app.inject({
      method: "POST",
      url: `/admin/api/schema/public/tables/${TABLE}/columns`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { name, dataType: "date", nullable: true, input: "date", config } },
    });

    const bad = await add("vence_mal", { linkType: "url" });
    expect(bad.statusCode).toBe(422);
    const { rows } = await context.database.query(
      `SELECT 1 FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'vence_mal'`,
      [`public.${TABLE}`],
    );
    expect(rows).toHaveLength(0);

    expect((await add("vence", { label: "Vence", displayFormat: "dd/MM/yyyy", min: 1 })).statusCode).toBe(422);
    expect((await add("vence", { label: "Vence", displayFormat: "dd/MM/yyyy" })).statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/admin/api/resources/${resourceId}/columns`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(list.json().data).toContainEqual(expect.objectContaining({ columnName: "vence", presentation: { label: "Vence", displayFormat: "dd/MM/yyyy", input: "date" } }));
  });

  it("Add Column makes a UID column whose value PostgreSQL generates, stored with its type key", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/admin/api/schema/public/tables/${TABLE}/columns`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { name: "codigo", dataType: "text", nullable: true, unique: true, uid: { source: "nota" }, input: "uid", config: {} } },
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await context.database.query<{ codigo: string }>(`INSERT INTO public.${TABLE} (nota) VALUES ('Nota Única') RETURNING codigo`);
    expect(rows[0]!.codigo).toBe("nota-unica");
    const list = await app.inject({ method: "GET", url: `/admin/api/resources/${resourceId}/columns`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(list.json().data).toContainEqual(expect.objectContaining({ columnName: "codigo", presentation: { input: "uid" } }));
  });

  it("sets a table's row presentation - the whole value, checked against its columns", async () => {
    const put = (data: unknown) => app.inject({
      method: "PUT",
      url: `/admin/api/resources/${resourceId}/row-presentation`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data },
    });
    const set = await put({ displayTemplate: "{{nota}} ({{id}})" });
    expect([set.statusCode, set.json().data]).toEqual([200, { displayTemplate: "{{nota}} ({{id}})" }]);
    const unknown = await put({ displayField: "missing" });
    expect([unknown.statusCode, unknown.json().errors[0].code]).toEqual([422, "INVALID_ROW_PRESENTATION"]);
    expect((await context.resourcesAdmin.get(resourceId)).rowPresentation).toEqual({ displayTemplate: "{{nota}} ({{id}})" });
    const cleared = await put({});
    expect([cleared.statusCode, cleared.json().data]).toEqual([200, {}]);
  });

  it("lists the DataViews that show a column - over a view's column that is it too; 404 for an unknown column", async () => {
    const VIEW = `${TABLE}_v`;
    await context.database.query(`CREATE VIEW public.${VIEW} AS SELECT id, total FROM public.${TABLE}`);
    const { rows: [view] } = await context.database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1::regclass::oid, 'public', $2, 'VIEW', 'ACTIVE') RETURNING id`,
      [`public.${VIEW}`, VIEW],
    );
    const onTable = await context.dataviewsAdmin.create({ name: "Columns usage table", slug: "columns-usage-table", sourceResourceId: resourceId, viewType: "TABLE" });
    const onView = await context.dataviewsAdmin.create({ name: "Columns usage view", slug: "columns-usage-view", sourceResourceId: view!.id, viewType: "TABLE" });
    try {
      const usage = (column: string) => app.inject({ method: "GET", url: `/admin/api/resources/${resourceId}/columns/${column}/dataviews`, headers: { authorization: `Bearer ${adminToken}` } });
      expect((await usage("total")).json().data).toEqual([{ id: onTable.id, name: "Columns usage table" }, { id: onView.id, name: "Columns usage view" }]);
      expect((await usage("nota")).json().data).toEqual([{ id: onTable.id, name: "Columns usage table" }]);
      const unknown = await usage("missing");
      expect([unknown.statusCode, unknown.json().errors[0].code]).toEqual([404, "UNDEFINED_COLUMN"]);
    } finally {
      await context.database.query(`DELETE FROM totalbase.dataviews WHERE id = ANY($1)`, [[onTable.id, onView.id]]);
      await context.database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [view!.id]);
      await context.database.query(`DROP VIEW public.${VIEW}`);
    }
  });

  it("answers 404 for an unknown resource's columns and affected DataViews", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const path of ["columns", "affected-dataviews"]) {
      const res = await app.inject({ method: "GET", url: `/admin/api/resources/${unknown}/${path}`, headers: { authorization: `Bearer ${adminToken}` } });
      expect([res.statusCode, res.json().errors?.[0]?.code], path).toEqual([404, "RESOURCE_NOT_FOUND"]);
    }
  });

  it("updates a resource's metadata from camelCase keys in data", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/resources/${resourceId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { exposedMethods: ["GET"], auditRead: true, description: "Route test" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ exposedMethods: ["GET"], auditRead: true, description: "Route test" });
  });

  // Suggest presentation (DataViews.md §15.6) from the default known column names.
  it("suggests by type and constraints - never by name - and applies what was accepted, merged into each presentation", async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const url = `/admin/api/resources/${resourceId}/columns/suggested-presentation`;
    const preview = await app.inject({ method: "GET", url, headers });
    expect(preview.statusCode).toBe(200);
    const review = preview.json().data as { columns: { columnName: string; suggestions: { key: string; value: unknown; replaces: boolean }[] }[] };
    const nota = review.columns.find((c) => c.columnName === "nota")!;
    // Nullable: shown as — where empty - by its type, not its name.
    expect(nota.suggestions).toEqual([expect.objectContaining({ key: "emptyText", value: "—", replaces: false })]);

    const applied = await app.inject({ method: "POST", url, headers, payload: { data: { columns: { total: { emptyText: "sin total" } } } } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toEqual([expect.objectContaining({ columnName: "total", presentation: { label: "Total", displayFormat: "CURRENCY:ARS", emptyText: "sin total" } })]);

    const bad = await app.inject({ method: "POST", url, headers, payload: { data: { columns: "total" } } });
    expect([bad.statusCode, bad.json().errors[0].code]).toEqual([422, "INVALID_COLUMN_PRESENTATION"]);
  });

  it("refuses an option the column's type doesn't take", async () => {
    const res = await put("nota", { displayFormat: "#,##0" });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0]).toMatchObject({ code: "INVALID_COLUMN_PRESENTATION" });
  });
});
