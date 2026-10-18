import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAdminContract, type AdminContract, type Schema } from "./admin-openapi-contract-support.js";

/**
 * The DataViews and App menu Admin API routes answer exactly what their
 * `config.openapi` documents (admin-dataviews.ts, admin-dataviews-states.ts,
 * app-menu.ts) - see admin-openapi-contract-support.ts.
 */
describe("Admin OpenAPI matches real responses - dataviews and app menu", () => {
  const P = "openapi_contract_dv";
  const BRANDS = `${P}_brands`;
  const ITEMS = `${P}_items`;
  let contract: AdminContract;
  let context: AdminContract["context"];
  let database: AdminContract["database"];
  let adminId: string;
  let brandsResource: string;
  let itemsResource: string;
  let roleId: string;
  let otherUserId: string;
  let dashboardId: string;
  let tableDv: string;
  let tableSlug: string;
  let customDv: string;
  const dataviews: string[] = [];
  /** The administrator's arrangement before this file touched it - restored in afterAll through PUT. */
  let menuSnapshot: unknown[] | undefined;
  type MenuNode = { kind: string; id: string; name: string; icon: string | null; children?: MenuNode[] };
  const toInput = (node: MenuNode): unknown =>
    node.kind === "GROUP" ? { kind: "GROUP", id: node.id, name: node.name, icon: node.icon, children: node.children!.map(toInput) } : { kind: node.kind, id: node.id };

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    contract.app.inject({ method, url, headers: { authorization: `Bearer ${contract.adminToken}` }, ...(payload === undefined ? {} : { payload: payload as object }) });

  /** Every property and required name of a documented object schema, through `$ref`/`allOf`. */
  function documented(schema: Schema & { required?: string[] }): { keys: Set<string>; required: Set<string> } {
    if (schema.$ref) return documented(contract.spec.components.schemas[schema.$ref.split("/").pop()!]!);
    if (schema.allOf) {
      const parts = schema.allOf.map(documented);
      return { keys: new Set(parts.flatMap((p) => [...p.keys])), required: new Set(parts.flatMap((p) => [...p.required])) };
    }
    return { keys: new Set(Object.keys(schema.properties ?? {})), required: new Set(schema.required ?? []) };
  }

  /** For shapes with optional keys: nothing undocumented, nothing required missing. */
  function expectDocumented(sample: Record<string, unknown>, schema: Schema, label: string) {
    const { keys, required } = documented(schema);
    expect(Object.keys(sample).filter((key) => !keys.has(key)), `${label}: undocumented keys`).toEqual([]);
    expect([...required].filter((key) => !(key in sample)), `${label}: missing required keys`).toEqual([]);
  }

  const component = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
  const items = (schema: Schema) => schema.items!;

  beforeAll(async () => {
    contract = await setupAdminContract();
    ({ context, database } = contract);
    adminId = (await contract.get("/admin/api/auth/me")).json().data.id;

    await database.query(`DROP TABLE IF EXISTS public.${ITEMS}, public.${BRANDS} CASCADE`);
    await database.query(`CREATE TABLE public.${BRANDS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    await database.query(
      `CREATE TABLE public.${ITEMS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, brand uuid REFERENCES public.${BRANDS} (id))`,
    );
    const register = async (table: string) =>
      (await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES ($1::regclass::oid::int, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
        [`public.${table}`, table],
      )).rows[0]!.id;
    brandsResource = await register(BRANDS);
    itemsResource = await register(ITEMS);
    // A presentation on `id`, so its field carries `inherited` too.
    await context.resourcesAdmin.updateColumnPresentation(itemsResource, "id", { label: "Item id" });

    roleId = (await context.roles.create(`${P}-role`, { appAccess: true })).id;
    otherUserId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email) VALUES ($1) RETURNING id`,
      [`${P.replace(/_/g, "-")}@example.com`],
    )).rows[0]!.id;
    dashboardId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.dashboards (name, slug) VALUES ($1, $2) RETURNING id`,
      ["OpenAPI contract DV dash", "openapi-contract-dv-dash"],
    )).rows[0]!.id;
    menuSnapshot = ((await contract.get("/admin/api/app/menu")).json().data.nodes as MenuNode[]).map(toInput);
  });

  afterAll(async () => {
    try {
      for (const id of [...dataviews].reverse()) await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [id]);
      if (dashboardId) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
      // The objects above took their menu rows with them; this puts the groups and order back as they were.
      if (menuSnapshot) {
        const restored = await call("PUT", "/admin/api/app/menu", { data: { nodes: menuSnapshot } });
        if (restored.statusCode !== 200) throw new Error(`menu restore failed: ${restored.body}`);
      }
      if (roleId) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
      if (otherUserId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [otherUserId]);
      for (const id of [itemsResource, brandsResource]) {
        if (id) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
      }
      await database.query(`DROP TABLE IF EXISTS public.${ITEMS}, public.${BRANDS} CASCADE`);
    } finally {
      await contract.close();
    }
  });

  it("creates a DataView and a page", async () => {
    const res = await call("POST", "/admin/api/dataviews", { data: { name: "OpenAPI contract DV", sourceResourceId: itemsResource, viewType: "TABLE" } });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data;
    tableDv = data.id;
    tableSlug = data.slug;
    dataviews.push(tableDv);
    // Every type answers the full DataView, as a read returns it.
    contract.expectKeys(data, contract.dataSchema("/admin/api/dataviews", "post", "201"), "POST /dataviews (TABLE)");

    const page = await call("POST", "/admin/api/dataviews", { data: { name: "OpenAPI contract DV page", viewType: "CUSTOM" } });
    expect(page.statusCode, page.body).toBe(201);
    customDv = page.json().data.id;
    dataviews.push(customDv);
    expectDocumented(page.json().data, contract.dataSchema("/admin/api/dataviews", "post", "201"), "POST /dataviews (CUSTOM)");
  });

  it("reads the draft", async () => {
    await contract.expectMatches("/admin/api/dataviews", "/admin/api/dataviews");
    await contract.expectMatches(`/admin/api/dataviews/${tableDv}`, "/admin/api/dataviews/{id}");
    await contract.expectMatches(`/admin/api/dataviews/by-slug/${tableSlug}`, "/admin/api/dataviews/by-slug/{slug}");

    // A page without a source has no primary key: optional keys may be absent, nothing undocumented.
    const page = (await contract.get(`/admin/api/dataviews/${customDv}`)).json().data;
    expectDocumented(page, contract.dataSchema("/admin/api/dataviews/{id}"), "GET /dataviews/{id} (CUSTOM)");

    const res = await contract.get(`/admin/api/dataviews/${tableDv}/fields`);
    expect(res.statusCode).toBe(200);
    const fieldSchema = items(contract.dataSchema("/admin/api/dataviews/{id}/fields"));
    const fields = res.json().data as Record<string, unknown>[];
    for (const field of fields) expectDocumented(field, fieldSchema, `field ${field.columnName ?? field.widget}`);
    // A column with a presentation carries every documented key.
    contract.expectKeys(fields.find((f) => f.kind === "COLUMN" && f.columnName === "id")!, fieldSchema, "COLUMN field id");
  });

  it("edits the draft", async () => {
    const patch = await call("PATCH", `/admin/api/dataviews/${tableDv}`, { data: { description: "OpenAPI contract", viewConfig: { features: { search: true } } } });
    expect(patch.statusCode, patch.body).toBe(200);
    contract.expectKeys(patch.json().data, contract.dataSchema("/admin/api/dataviews/{id}", "patch"), "PATCH /dataviews/{id}");

    const name = (await contract.get(`/admin/api/dataviews/${tableDv}/fields`)).json().data.find((f: { columnName: string }) => f.columnName === "name");
    const field = await call("PATCH", `/admin/api/dataviews/${tableDv}/fields/${name.id}`, { data: { visible: false } });
    expect(field.statusCode, field.body).toBe(200);
    expectDocumented(field.json().data, contract.dataSchema("/admin/api/dataviews/{id}/fields/{fieldId}", "patch"), "PATCH field");

    const sync = await call("POST", `/admin/api/dataviews/${tableDv}/sync-fields`);
    expect(sync.statusCode, sync.body).toBe(200);
    contract.expectKeys(sync.json().data, contract.dataSchema("/admin/api/dataviews/{id}/sync-fields", "post"), "POST sync-fields");

    const columns = await call("POST", `/admin/api/dataviews/${tableDv}/columns`, { data: ["brand.name"] });
    expect(columns.statusCode, columns.body).toBe(201);
    const columnSchema = items(contract.dataSchema("/admin/api/dataviews/{id}/columns", "post", "201"));
    for (const added of columns.json().data) {
      expectDocumented(added, columnSchema, "POST columns");
      expect(added.dataType, "POST columns: its column's type, as a read gives it").toBe("text");
    }

    const code = await call("POST", `/admin/api/dataviews/${customDv}/code`, { data: { code: "// openapi contract" } });
    expect(code.statusCode, code.body).toBe(204);
    expect(contract.spec.paths["/admin/api/dataviews/{id}/code"]!.post!.responses["204"]).toBeDefined();

    const widget = await call("POST", `/admin/api/dataviews/${customDv}/widgets`, { data: { widget: "UCard" } });
    expect(widget.statusCode, widget.body).toBe(201);
    expectDocumented(widget.json().data, contract.dataSchema("/admin/api/dataviews/{id}/widgets", "post", "201"), "POST widgets");

    // A tree in one call: a card holding a heading; then the heading moved first among the card's content.
    const tree = await call("POST", `/admin/api/dataviews/${customDv}/widgets/tree`, {
      data: { widgets: [{ widget: "UCard", label: "contract_card", children: [{ widget: "THeading", config: { slot: "default", props: { label: "A" } } }, { widget: "THeading", config: { slot: "default", props: { label: "B" } } }] }] },
    });
    expect(tree.statusCode, tree.body).toBe(201);
    expect(tree.json().data).toHaveLength(3);
    for (const placed of tree.json().data) expectDocumented(placed, items(contract.dataSchema("/admin/api/dataviews/{id}/widgets/tree", "post", "201")), "POST widgets/tree");
    const [card, , second] = tree.json().data as { id: string; parent: string | null }[];
    expect(second!.parent).toBe(card!.id);
    const moved = await call("POST", `/admin/api/dataviews/${customDv}/widgets/${second!.id}/move`, { data: { position: 0 } });
    expect(moved.statusCode, moved.body).toBe(200);
    for (const field of moved.json().data) expectDocumented(field, items(contract.dataSchema("/admin/api/dataviews/{id}/widgets/{fieldId}/move", "post")), "POST widgets/{fieldId}/move");
    expect(moved.json().data.find((f: { id: string }) => f.id === second!.id).gridY).toBe(0);
    expect((await call("DELETE", `/admin/api/dataviews/${customDv}/fields/${card!.id}`)).statusCode).toBe(204);

    expect((await call("DELETE", `/admin/api/dataviews/${customDv}/fields/${widget.json().data.id}`)).statusCode).toBe(204);
  });

  it("object access and its warnings", async () => {
    const roles = await call("PUT", `/admin/api/dataviews/${tableDv}/roles`, { data: { roleIds: [roleId] } });
    expect(roles.statusCode, roles.body).toBe(200);
    expect(roles.json().data).toEqual([roleId]);
    expect(contract.dataSchema("/admin/api/dataviews/{id}/roles", "put").type).toBe("array");

    // Maps keyed by column path / variable name: their values' shapes are what's documented.
    const related = await contract.get(`/admin/api/dataviews/${tableDv}/related-access`);
    expect(related.statusCode).toBe(200);
    expect(related.json().data).toEqual({ "brand.name": [roleId] });
    expect(contract.dataSchema("/admin/api/dataviews/{id}/related-access").type).toBe("object");

    await call("PATCH", `/admin/api/dataviews/${customDv}`, {
      data: {
        viewConfig: {
          variables: [{ name: "items", kind: "RESOURCE", resource: itemsResource, query: { fields: "id" }, mode: "list", immediate: true, watch: false, count: false }],
        },
      },
    });
    await call("PUT", `/admin/api/dataviews/${customDv}/roles`, { data: { roleIds: [roleId] } });
    const resource = await contract.get(`/admin/api/dataviews/${customDv}/resource-access`);
    expect(resource.statusCode, resource.body).toBe(200);
    const lacking = resource.json().data.items as Record<string, unknown>[];
    expect(lacking).toHaveLength(1);
    const resourceSchema = contract.dataSchema("/admin/api/dataviews/{id}/resource-access") as Schema & { additionalProperties: Schema };
    contract.expectKeys(lacking[0]!, items(resourceSchema.additionalProperties), "resource-access entry");

    const dashboard = await contract.get(`/admin/api/dataviews/${tableDv}/dashboard-access?dashboard=${dashboardId}`);
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(dashboard.json().data).toEqual([roleId]);

    // The diagnosis (Specification_DataViews.md §18): the same answers, one list per object, and all at once.
    const issue = (code: string, more: Record<string, unknown> = {}) => expect.objectContaining({ code, role: expect.objectContaining({ id: roleId }), ...more });
    const table = await contract.get(`/admin/api/dataviews/${tableDv}/diagnosis`);
    expect(table.statusCode, table.body).toBe(200);
    expect(table.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NOT_PUBLISHED" }), issue("ROLE_CANNOT_READ")]));
    for (const entry of table.json().data) contract.expectKeys(entry, items(contract.dataSchema("/admin/api/dataviews/{id}/diagnosis")), "diagnosis entry");
    const page = await contract.get(`/admin/api/dataviews/${customDv}/diagnosis`);
    expect(page.json().data).toEqual(expect.arrayContaining([issue("ROLE_VARIABLE_REFUSED", { variable: "items" })]));
    const board = await contract.get(`/admin/api/dashboards/${dashboardId}/diagnosis`);
    expect(board.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NOT_PUBLISHED" })]));
    const all = await contract.get(`/admin/api/diagnosis`);
    expect(all.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "DATAVIEW", id: tableDv }), expect.objectContaining({ kind: "DASHBOARD", id: dashboardId })]));

    // A role that reads the items but not their brand's name, and writes nothing: an id in place of the brand, and
    // the writes the DataView offers but not to them.
    await contract.context.permissions.set(roleId, itemsResource, "READ", { effect: "ALLOW", fields: ["id", "name", "brand"].map((field) => ({ field, effect: "ALLOW" as const })) });
    const reading = (await contract.get(`/admin/api/dataviews/${tableDv}/diagnosis`)).json().data;
    expect(reading).toEqual(expect.arrayContaining([
      issue("ROLE_SEES_KEY", { columns: ["brand.name"], severity: "warning" }),
      issue("ROLE_CANNOT_WRITE", { actions: ["CREATE", "UPDATE", "DELETE"], severity: "info" }),
    ]));
    expect(reading.map((i: { code: string }) => i.code)).not.toContain("ROLE_CANNOT_READ");
    await contract.database.query(`DELETE FROM totalbase.permissions WHERE role = $1 AND resource = $2`, [roleId, itemsResource]);
  });

  it("detail candidates", async () => {
    const res = await contract.get(`/admin/api/dataviews/detail-candidates?master=${brandsResource}`);
    expect(res.json().data).toEqual([expect.objectContaining({ resourceId: itemsResource, fkColumn: "brand" })]);
    await contract.expectMatches(`/admin/api/dataviews/detail-candidates?master=${brandsResource}`, "/admin/api/dataviews/detail-candidates");
  });

  it("versioning: publish, versions, published reads, restore, duplicate", async () => {
    const publish = await call("POST", `/admin/api/dataviews/${tableDv}/publish`);
    expect(publish.statusCode, publish.body).toBe(201);
    contract.expectKeys(publish.json().data, contract.dataSchema("/admin/api/dataviews/{id}/publish", "post", "201"), "POST publish");
    const version = publish.json().data.version as number;

    await contract.expectMatches(`/admin/api/dataviews/${tableDv}/versions`, "/admin/api/dataviews/{id}/versions");
    await contract.expectMatches(`/admin/api/dataviews/${tableDv}/versions/${version}`, "/admin/api/dataviews/{id}/versions/{version}");
    const content = (await contract.get(`/admin/api/dataviews/${tableDv}/versions/${version}`)).json().data;
    contract.expectKeys(content.dataview, component("DataView"), "version content's dataview");
    for (const field of content.fields) expectDocumented(field, component("DataViewField"), "version content's field");

    await contract.expectMatches(`/admin/api/dataviews/by-slug/${tableSlug}/published`, "/admin/api/dataviews/by-slug/{slug}/published");
    const published = await contract.get(`/admin/api/dataviews/${tableDv}/fields/published`);
    expect(published.statusCode).toBe(200);
    for (const field of published.json().data) expectDocumented(field, items(contract.dataSchema("/admin/api/dataviews/{id}/fields/published")), "published field");

    const restore = await call("POST", `/admin/api/dataviews/${tableDv}/versions/${version}/restore`);
    expect(restore.statusCode, restore.body).toBe(200);
    contract.expectKeys(restore.json().data, contract.dataSchema("/admin/api/dataviews/{id}/versions/{version}/restore", "post"), "POST restore");

    const duplicate = await call("POST", `/admin/api/dataviews/${tableDv}/versions/${version}/duplicate`, { data: { name: "OpenAPI contract DV copy" } });
    expect(duplicate.statusCode, duplicate.body).toBe(201);
    dataviews.push(duplicate.json().data.id);
    contract.expectKeys(duplicate.json().data, contract.dataSchema("/admin/api/dataviews/{id}/versions/{version}/duplicate", "post", "201"), "POST duplicate");
    expect((await call("DELETE", `/admin/api/dataviews/${duplicate.json().data.id}`)).statusCode).toBe(204);
  });

  it("the App menu", async () => {
    const res = await contract.get("/admin/api/app/menu");
    expect(res.statusCode).toBe(200);
    const menu = res.json().data;
    contract.expectKeys(menu, contract.dataSchema("/admin/api/app/menu"), "GET /app/menu");
    const object = menu.nodes.find((n: { kind: string; id: string }) => n.kind === "DATAVIEW" && n.id === tableDv);
    contract.expectKeys(object, component("AppMenuObject"), "menu object");

    // The current arrangement as saved, plus a group holding the published DataView - restored in afterAll.
    const rest = (menu.nodes as MenuNode[]).filter((n) => !(n.kind === "DATAVIEW" && n.id === tableDv)).map(toInput);
    const put = await call("PUT", "/admin/api/app/menu", {
      data: { nodes: [{ kind: "GROUP", name: "OpenAPI contract DV", icon: null, children: [{ kind: "DATAVIEW", id: tableDv }] }, ...rest] },
    });
    expect(put.statusCode, put.body).toBe(200);
    const saved = put.json().data;
    contract.expectKeys(saved, contract.dataSchema("/admin/api/app/menu", "put"), "PUT /app/menu");
    contract.expectKeys(saved.nodes[0], component("AppMenuGroup"), "menu group");
    contract.expectKeys(saved.nodes[0].children[0], component("AppMenuObject"), "menu group's item");
  });
});
