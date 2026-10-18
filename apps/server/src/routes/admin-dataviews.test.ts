import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

/**
 * DataView management routes - the wizard's steps 1-2 (identity, source).
 * See Specification_DataViews.md. Admin-only, same as every
 * other admin-plane route family.
 */
describe("/admin/api/dataviews", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let resourceId: string;
  let createdId: string;
  let createdWithConfigId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.admin_dataviews_route_test_items CASCADE`);
    await database.query(`
      CREATE TABLE public.admin_dataviews_route_test_items (
        id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL
      )
    `);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.admin_dataviews_route_test_items')::oid, 'public', 'admin_dataviews_route_test_items', 'TABLE', 'ACTIVE', ARRAY['GET'])
       RETURNING id`,
    );
    resourceId = rows[0]!.id;

    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
  });

  afterAll(async () => {
    if (createdId) await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [createdId]);
    if (createdWithConfigId) await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [createdWithConfigId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.admin_dataviews_route_test_items CASCADE`);
    await app.close();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/dataviews" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a DataView and returns 201 with auto-populated fields implied", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/dataviews",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        data: {
          name: "Route Test Items",
          sourceResourceId: resourceId,
          viewType: "TABLE",
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.slug).toBe("route-test-items");
    expect(data.sourceResource).toBe(resourceId);
    createdId = data.id;
    // The same shape a read returns, whatever the type - not only the row.
    const read = await app.inject({ method: "GET", url: `/admin/api/dataviews/${createdId}`, headers: { authorization: `Bearer ${adminToken}` } });
    const { hasUnpublishedChanges: _status, ...readShape } = read.json().data;
    expect(data).toEqual(readShape);
    expect(data.sourceResourcePrimaryKey).toEqual(["id"]);
    expect(data.columnPresentation).toEqual(expect.any(Object));

    const { rows: fields } = await database.query<{ column_name: string }>(
      `SELECT column_name FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind = 'COLUMN'`,
      [createdId],
    );
    expect(fields.map((f) => f.column_name).sort()).toEqual(["id", "name"]);
  });

  it("answers 400 to a create without a { data } body", async () => {
    for (const payload of [undefined, { name: "No envelope", viewType: "TABLE", sourceResourceId: resourceId }]) {
      const res = await app.inject({ method: "POST", url: "/admin/api/dataviews", headers: { authorization: `Bearer ${adminToken}` }, ...(payload ? { payload } : {}) });
      expect(res.statusCode, res.body).toBe(400);
    }
  });

  it("honors selectedColumns and viewConfig from the wizard's steps 4-5", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/dataviews",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        data: {
          name: "Route Test Items 2",
          sourceResourceId: resourceId,
          viewType: "TABLE",
          selectedColumns: ["name"],
          viewConfig: { features: { search: true, filter: false } },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.viewConfig).toEqual({ features: { search: true, filter: false }, variables: expect.any(Array), last_attnum: expect.any(Number) });
    createdWithConfigId = data.id;

    const fields = await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${data.id}/fields`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const byName = fields.json().data as { columnName: string, visible: boolean }[];
    expect(byName.find((f) => f.columnName === "name")?.visible).toBe(true);
    // The primary key isn't selected: it's in the DataView all the same, hidden - editing and deleting a row need it.
    expect(byName.find((f) => f.columnName === "id")?.visible).toBe(false);
  });

  it("adds columns to a DataView with POST /columns, and refuses what isn't a list of names", async () => {
    const add = (payload: unknown) => app.inject({
      method: "POST",
      url: `/admin/api/dataviews/${createdWithConfigId}/columns`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: payload as Record<string, unknown>,
    });
    await database.query(`ALTER TABLE public.admin_dataviews_route_test_items ADD COLUMN note text`);
    try {
      const res = await add({ data: ["note"] });
      expect(res.statusCode, res.body).toBe(201);
      // As a field read returns it - with its column's type.
      expect(res.json().data).toEqual([expect.objectContaining({ kind: "COLUMN", columnName: "note", visible: true, dataType: "text" })]);
      const read = await app.inject({ method: "GET", url: `/admin/api/dataviews/${createdWithConfigId}/fields`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(read.json().data.find((f: { columnName: string }) => f.columnName === "note")).toEqual(res.json().data[0]);
      expect((await add({ data: [] })).statusCode).toBe(400);
      expect((await add({ columns: ["note"] })).statusCode).toBe(400);
      // Already in it: a conflict, not a missing field; not a column of the table: invalid input.
      const again = await add({ data: ["note"] });
      expect(again.statusCode).toBe(409);
      expect(again.json().errors[0].code).toBe("DATAVIEW_FIELD_DUPLICATE");
      const unknown = await add({ data: ["no_such_column"] });
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json().errors[0].code).toBe("DATAVIEW_COLUMN_INVALID");
    } finally {
      await database.query(`ALTER TABLE public.admin_dataviews_route_test_items DROP COLUMN note`);
    }
  });

  it("tells which roles opening the DataView lack a related column's path (GET /related-access)", async () => {
    const owners = "admin_dataviews_route_test_owners";
    await database.query(`DROP TABLE IF EXISTS public.${owners} CASCADE`);
    await database.query(`CREATE TABLE public.${owners} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    await database.query(`ALTER TABLE public.admin_dataviews_route_test_items ADD COLUMN owner uuid REFERENCES public.${owners} (id)`);
    const ownersResource = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1::regclass::oid::int, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      [`public.${owners}`, owners],
    )).rows[0]!.id;
    const granted = (await context.roles.create("admin-dataviews-route-test-granted", { appAccess: true })).id;
    const lacking = (await context.roles.create("admin-dataviews-route-test-lacking", { appAccess: true })).id;
    const access = async () => (await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdWithConfigId}/related-access`,
      headers: { authorization: `Bearer ${adminToken}` },
    })).json().data;
    try {
      await context.dataviewsAdmin.addColumns(createdWithConfigId, ["owner.name"]);
      await context.dataviewsAdmin.setRoles(createdWithConfigId, [granted, lacking]);
      await context.permissions.set(granted, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner", "owner.name"].map((field) => ({ field, effect: "ALLOW" as const })) });
      await context.permissions.set(lacking, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect(await access()).toEqual({ "owner.name": [lacking] });
    } finally {
      await context.dataviewsAdmin.setRoles(createdWithConfigId, []);
      const related = (await context.dataviewsAdmin.listFields(createdWithConfigId)).find((f) => f.kind === "RELATED");
      if (related) await context.dataviewsAdmin.deleteField(createdWithConfigId, related.id);
      await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [[granted, lacking]]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [ownersResource]);
      await database.query(`ALTER TABLE public.admin_dataviews_route_test_items DROP COLUMN owner`);
      await database.query(`DROP TABLE IF EXISTS public.${owners} CASCADE`);
    }
  });

  // Specification_DataViews.md §8.3, "All or nothing".
  it("tells which roles opening a page can't READ a Resource's table or a column its query reads (GET /resource-access)", async () => {
    const page = await context.dataviewsAdmin.create({ name: "Admin DV route resource access", viewType: "CUSTOM" });
    const full = (await context.roles.create("admin-dataviews-route-test-full", { appAccess: true })).id;
    const partial = (await context.roles.create("admin-dataviews-route-test-partial", { appAccess: true })).id;
    const none = (await context.roles.create("admin-dataviews-route-test-none", { appAccess: true })).id;
    try {
      await context.dataviewsAdmin.update(page.id, {
        viewConfig: {
          variables: [{ name: "items", kind: "RESOURCE", resource: resourceId, query: { fields: "id", order_by: "-name" }, mode: "list", immediate: true, watch: false, count: false }],
        },
      });
      await context.dataviewsAdmin.setRoles(page.id, [full, partial, none]);
      await context.permissions.set(full, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name"].map((field) => ({ field, effect: "ALLOW" as const })) });
      await context.permissions.set(partial, resourceId, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" as const }] });
      const res = await app.inject({ method: "GET", url: `/admin/api/dataviews/${page.id}/resource-access`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(res.json().data).toEqual({ items: [{ role: partial, columns: ["name"] }, { role: none, columns: null }] });
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [page.id]);
      await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [[full, partial, none]]);
    }
  });

  it("tells which roles opening the DataView can't see a Dashboard it embeds (GET /dashboard-access)", async () => {
    const dashboard = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.dashboards (name, slug) VALUES ('Admin DV route dash', 'admin-dv-route-dash') RETURNING id`,
    )).rows[0]!.id;
    const both = (await context.roles.create("admin-dataviews-route-test-both", { appAccess: true })).id;
    const pageOnly = (await context.roles.create("admin-dataviews-route-test-page-only", { appAccess: true })).id;
    const access = (query: string) => app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdWithConfigId}/dashboard-access${query}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    try {
      await context.dataviewsAdmin.setRoles(createdWithConfigId, [both, pageOnly]);
      await context.dashboardsAdmin.setRoles(dashboard, [both]);
      expect((await access(`?dashboard=${dashboard}`)).json().data).toEqual([pageOnly]);
      expect((await access("")).statusCode).toBe(400);
    } finally {
      await context.dataviewsAdmin.setRoles(createdWithConfigId, []);
      await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboard]);
      await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [[both, pageOnly]]);
    }
  });

  it("gets the DataView by slug and lists its fields via the dedicated endpoints", async () => {
    const bySlug = await app.inject({
      method: "GET",
      url: "/admin/api/dataviews/by-slug/route-test-items",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json().data.id).toBe(createdId);

    const fields = await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdId}/fields`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(fields.statusCode).toBe(200);
    expect(fields.json().data.filter((f: { kind: string }) => f.kind === "COLUMN").map((f: { columnName: string }) => f.columnName).sort()).toEqual(["id", "name"]);
  });

  it("gets the created DataView by id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("Route Test Items");
  });

  it("lists DataViews including the created one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/dataviews",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.some((d: { id: string }) => d.id === createdId)).toBe(true);
  });

  it("patches the description", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/dataviews/${createdId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { description: "Updated via route test" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.description).toBe("Updated via route test");
  });

  it("patches viewConfig by merging, not replacing (edit_presentation alongside the existing features)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/dataviews/${createdId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { viewConfig: { edit_presentation: "SIDEBAR" } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.viewConfig).toMatchObject({ edit_presentation: "SIDEBAR" });

    const again = await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    // Still there after a second, unrelated GET - a real merge, not a fluke of the same request.
    expect(again.json().data.viewConfig.edit_presentation).toBe("SIDEBAR");
  });


  it("patches a column's position and size - never a title of its own (its table's column's)", async () => {
    const fields = await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdId}/fields`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const nameField = (fields.json().data as { id: string, columnName: string }[]).find((f) => f.columnName === "name")!;

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/dataviews/${createdId}/fields/${nameField.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { gridX: 0, gridY: 5, gridW: 6, gridH: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.label).toBeNull();
    expect(data.gridY).toBe(5);
    expect(data.gridW).toBe(6);
    const titled = await app.inject({
      method: "PATCH",
      url: `/admin/api/dataviews/${createdId}/fields/${nameField.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { label: "Item Name" } },
    });
    expect([titled.statusCode, titled.json().errors[0].code]).toEqual([422, "DATAVIEW_COLUMN_INVALID"]);
  });

  it("sync-fields reconciles a column added to the source table after DataView creation (schema drift)", async () => {
    await database.query(`ALTER TABLE public.admin_dataviews_route_test_items ADD COLUMN IF NOT EXISTS note text`);

    const sync = await app.inject({
      method: "POST",
      url: `/admin/api/dataviews/${createdId}/sync-fields`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(sync.statusCode).toBe(200);
    const result = sync.json().data;
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ kind: "COLUMN", columnName: "note", visible: false });
    expect(result.renamed).toEqual([]);
    expect(result.orphaned).toEqual([]);

    const fields = await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdId}/fields`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((fields.json().data as { columnName: string }[]).some((f) => f.columnName === "note")).toBe(true);

    // Idempotent - nothing left to add on a second call.
    const syncAgain = await app.inject({
      method: "POST",
      url: `/admin/api/dataviews/${createdId}/sync-fields`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(syncAgain.json().data).toEqual({ added: [], renamed: [], orphaned: [] });
  });

  it("validates a :version path parameter - 400 when not a number, 404 for a version that doesn't exist", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    for (const [method, suffix] of [["GET", ""], ["POST", "/restore"]] as const) {
      expect((await app.inject({ method, url: `/admin/api/dataviews/${createdId}/versions/abc${suffix}`, headers: auth })).statusCode).toBe(400);
      expect((await app.inject({ method, url: `/admin/api/dataviews/${createdId}/versions/1.5${suffix}`, headers: auth })).statusCode).toBe(400);
      const missing = await app.inject({ method, url: `/admin/api/dataviews/${createdId}/versions/999${suffix}`, headers: auth });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().errors[0].code).toBe("DATAVIEW_VERSION_NOT_FOUND");
    }
    const duplicate = await app.inject({ method: "POST", url: `/admin/api/dataviews/${createdId}/versions/x/duplicate`, headers: auth, payload: { data: { name: "Never" } } });
    expect(duplicate.statusCode).toBe(400);
  });

  it("previews a version with that version's variable resources, not the draft's", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const page = await context.dataviewsAdmin.create({ name: "Admin DV route version vars", viewType: "CUSTOM" });
    try {
      const variables = [{ name: "items", kind: "RESOURCE", resource: resourceId, query: { fields: "id" }, mode: "list", immediate: true, watch: false, count: false }];
      await context.dataviewsAdmin.update(page.id, { viewConfig: { variables } });
      const published = await app.inject({ method: "POST", url: `/admin/api/dataviews/${page.id}/publish`, headers: auth });
      expect(published.statusCode).toBe(201);
      // The draft drops the variable; version 1 still has it.
      await context.dataviewsAdmin.update(page.id, { viewConfig: { variables: [] } });
      const version = await app.inject({ method: "GET", url: `/admin/api/dataviews/${page.id}/versions/1`, headers: auth });
      expect(version.statusCode).toBe(200);
      expect(Object.keys(version.json().data.dataview.variableResources)).toEqual([resourceId]);
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [page.id]);
    }
  });

  it("saves a page's code with 204 and no body", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const page = await context.dataviewsAdmin.create({ name: "Admin DV route code", viewType: "CUSTOM" });
    try {
      const res = await app.inject({ method: "POST", url: `/admin/api/dataviews/${page.id}/code`, headers: auth, payload: { data: { code: "// saved" } } });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect((await context.dataviewsAdmin.get(page.id)).code).toBe("// saved");
      expect((await app.inject({ method: "POST", url: `/admin/api/dataviews/${page.id}/code`, headers: auth, payload: { code: "// no envelope" } })).statusCode).toBe(400);
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [page.id]);
    }
  });

  it("deletes the DataView, returning 204, then 404s on a further get", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/admin/api/dataviews/${createdId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: `/admin/api/dataviews/${createdId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(get.statusCode).toBe(404);
    createdId = "";
  });
});
