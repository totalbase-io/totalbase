import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataViewsAdminService } from "./dataviews-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const PREFIX = "dataviews-custom-test";
const TABLE = "dataviews_custom_test_clientes";
const HIDDEN = "dataviews_custom_test_hidden";
const ORDERS = "dataviews_custom_test_pedidos";

/**
 * CUSTOM DataViews (DataViews.md): no source, variables
 * in view_config, widgets of the widget catalog as WIDGET fields - every
 * rule of the widget and variable catalogs held by the Admin API itself.
 */
describe("CUSTOM DataViews (integration)", () => {
  let database: Database;
  let dataviewsAdmin: DataViewsAdminService;
  let tableResource: string;
  let hiddenResource: string;
  let VARIABLES: unknown[];

  const resourceVariable = (resource: string, query: Record<string, unknown> = { fields: "id,nombre" }) => ({
    name: "clientes",
    kind: "RESOURCE",
    resource,
    query,
    mode: "list",
    immediate: true,
    watch: false,
    count: false,
  });

  async function cleanup() {
    await database.query(`DELETE FROM totalbase.dataviews WHERE slug LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.workflows WHERE slug LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name IN ('${TABLE}', '${HIDDEN}', '${ORDERS}')`);
    await database.query(`DROP TABLE IF EXISTS public.${ORDERS}, public.${TABLE}, public.${HIDDEN}`);
  }

  async function custom(suffix: string, variables: unknown[] = VARIABLES) {
    return dataviewsAdmin.create({ name: `Custom ${suffix}`, slug: `${PREFIX}-${suffix}`, viewType: "CUSTOM", viewConfig: { variables } });
  }

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dataviewsAdmin = new DataViewsAdminService(database);
    await cleanup();
    await database.query(`CREATE TABLE public.${TABLE} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nombre text)`);
    await database.query(`CREATE TABLE public.${HIDDEN} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)`);
    const register = async (name: string, exposed: string) =>
      (
        await database.query<{ id: string }>(
          `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
           VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
          [`public.${name}`, name, exposed],
        )
      ).rows[0]!.id;
    tableResource = await register(TABLE, "{GET}");
    hiddenResource = await register(HIDDEN, "{}");
    VARIABLES = [{ name: "cliente", kind: "VALUE", type: "number" }, resourceVariable(tableResource)];
    const workflow = (trigger: string) => ({ operations: [{ id: "start", type: "totalbase.start", configuration: { trigger } }] });
    await database.query(`INSERT INTO totalbase.workflows (name, slug, definition) VALUES ('Custom manual', '${PREFIX}-manual', $1), ('Custom cron', '${PREFIX}-cron', $2)`, [
      JSON.stringify(workflow("MANUAL")),
      JSON.stringify(workflow("CRON")),
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await database.close();
  });

  it("creates a CUSTOM DataView with no source and its variables", async () => {
    const dataview = await custom("create");
    expect(dataview.viewType).toBe("CUSTOM");
    expect(dataview.sourceResource).toBeNull();
    expect(dataview.viewConfig.variables).toEqual(VARIABLES);
    expect(await dataviewsAdmin.listFields(dataview.id)).toEqual([]);
    // The Data API addresses a resource by schema and name; variables store its id.
    expect(dataview.variableResources).toEqual({ [tableResource]: { schema: "public", name: TABLE, type: "TABLE", columns: { id: "bigint", nombre: "text" } } });
  });

  it("says how each of a Resource's foreign keys shows - its table's row presentation, else its default column", async () => {
    await database.query(`CREATE TABLE public.${ORDERS} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, cliente bigint REFERENCES public.${TABLE} (id))`);
    const orders = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      [`public.${ORDERS}`, ORDERS],
    )).rows[0]!.id;
    const page = await custom("fk-display", [{ ...resourceVariable(orders, { fields: "id,cliente" }), name: "pedidos" }]);
    const target = { schema: "public", table: TABLE, column: "id" };
    expect(page.variableResources?.[orders]?.displays).toEqual({ cliente: { ...target, displayField: "nombre" } });
    await database.query(`UPDATE totalbase.resources SET row_presentation = '{"displayTemplate": "{{nombre}} ({{id}})"}' WHERE id = $1`, [tableResource]);
    // A published version keeps the one it was published with (§15.5).
    await dataviewsAdmin.publish(page.id, null);
    expect((await dataviewsAdmin.get(page.id)).variableResources?.[orders]?.displays).toEqual({ cliente: { ...target, displayField: "nombre", displayTemplate: "{{nombre}} ({{id}})" } });
    await database.query(`UPDATE totalbase.resources SET row_presentation = '{}' WHERE id = $1`, [tableResource]);
    expect((await dataviewsAdmin.getPublishedBySlug(page.slug)).variableResources?.[orders]?.displays?.cliente?.displayTemplate).toBe("{{nombre}} ({{id}})");
  });

  it("gives a page without one its record table, once - a table only", async () => {
    const dataview = await custom("rec-later");
    expect((await dataviewsAdmin.update(dataview.id, { sourceResourceId: tableResource })).sourceResource).toBe(tableResource);
    // Its widgets are bound to those columns by now: another table is refused.
    await expect(dataviewsAdmin.update(dataview.id, { sourceResourceId: tableResource })).rejects.toMatchObject({ code: "DATAVIEW_SOURCE_TYPE_INVALID" });
    const table = await dataviewsAdmin.create({ name: "Custom later table", slug: `${PREFIX}-lt`, viewType: "TABLE", sourceResourceId: tableResource });
    await expect(dataviewsAdmin.update(table.id, { sourceResourceId: tableResource })).rejects.toMatchObject({ code: "DATAVIEW_SOURCE_TYPE_INVALID" });
  });

  it("refuses invalid variables on create and on update", async () => {
    await expect(custom("bad-create", [{ name: "vars", kind: "VALUE", type: "text" }])).rejects.toMatchObject({ code: "DATAVIEW_VARIABLES_INVALID" });
    const dataview = await custom("bad-update");
    await expect(
      dataviewsAdmin.update(dataview.id, { viewConfig: { variables: [{ name: "a", kind: "VALUE", type: "number", default: { source: "formula", formula: "{{vars.a.value}}" } }] } }),
    ).rejects.toMatchObject({ code: "DATAVIEW_VARIABLES_INVALID" });
  });

  it("checks what the catalog can't: an exposed table or view, a parsable filter, an exposed function, a MANUAL workflow", async () => {
    const expectInvalid = (variables: unknown[], message: string) =>
      expect(custom(`db-${Math.random().toString(36).slice(2, 8)}`, variables)).rejects.toMatchObject({ code: "DATAVIEW_VARIABLES_INVALID", message });
    await expectInvalid([resourceVariable("00000000-0000-4000-8000-000000000000")], "clientes: the resource isn't an active table or view.");
    await expectInvalid([resourceVariable(hiddenResource)], "clientes: the resource isn't exposed for reading (GET).");
    await expectInvalid(
      [resourceVariable(tableResource, { fields: "id", where: { nombre: { _whatever: "x" } } })],
      expect.stringContaining("clientes: the filter isn't valid") as unknown as string,
    );
    const workflowId = async (slug: string) => (await database.query<{ id: string }>(`SELECT id FROM totalbase.workflows WHERE slug = $1`, [slug])).rows[0]!.id;
    await expectInvalid([{ name: "emitir", kind: "CALL", target: { type: "WORKFLOW", workflow: "00000000-0000-4000-8000-000000000000" } }], "emitir: the workflow doesn't exist.");
    await expectInvalid([{ name: "emitir", kind: "CALL", target: { type: "WORKFLOW", workflow: `${PREFIX}-manual` } }], "emitir: the workflow doesn't exist.");
    await expectInvalid(
      [{ name: "emitir", kind: "CALL", target: { type: "WORKFLOW", workflow: await workflowId(`${PREFIX}-cron`) } }],
      "emitir: only a MANUAL workflow runs from a page, as the viewer.",
    );
    await expectInvalid([{ name: "calc", kind: "CALL", target: { type: "FUNCTION", resource: tableResource } }], "calc: the function doesn't exist.");
    const manual = await workflowId(`${PREFIX}-manual`);
    const page = await custom("db-ok", [...VARIABLES, { name: "emitir", kind: "CALL", target: { type: "WORKFLOW", workflow: manual } }]);
    expect(page.viewType).toBe("CUSTOM");
    // The Call keeps its workflow by id: a renamed slug is what the page runs it by next.
    await database.query(`UPDATE totalbase.workflows SET slug = $2 WHERE id = $1`, [manual, `${PREFIX}-renamed`]);
    expect((await dataviewsAdmin.get(page.id)).variableWorkflows).toEqual({ [manual]: { slug: `${PREFIX}-renamed`, name: "Custom manual" } });
    await database.query(`UPDATE totalbase.workflows SET slug = $2 WHERE id = $1`, [manual, `${PREFIX}-manual`]);
  });

  it("takes a record table and its events, and refuses a view or an unknown event", async () => {
    const page = await dataviewsAdmin.create({ name: "Rec", slug: `${PREFIX}-rec`, viewType: "CUSTOM", sourceResourceId: tableResource, viewConfig: { record: { emits: { save: "onSave" } } } });
    expect(page.sourceResource).toBe(tableResource);
    await expect(dataviewsAdmin.update(page.id, { viewConfig: { record: { emits: { submit: "x" } } } })).rejects.toMatchObject({
      code: "DATAVIEW_VARIABLES_INVALID",
      message: 'record: a Record has no event "submit".',
    });
    const updated = await dataviewsAdmin.update(page.id, { viewConfig: { record: { emits: { "before:save": "check" } } } });
    expect(updated.viewConfig.record).toEqual({ emits: { "before:save": "check" } });
  });

  it("checks a table Call's table is exposed for its write", async () => {
    const tableCall = (resource: string, action: string) => ({ name: "guardar", kind: "CALL", target: { type: "TABLE", resource, action } });
    await expect(custom("tc-post", [tableCall(hiddenResource, "CREATE")])).rejects.toMatchObject({ message: "guardar: the table isn't exposed for POST." });
    await expect(custom("tc-del", [tableCall(tableResource, "DELETE")])).rejects.toMatchObject({ message: "guardar: the table isn't exposed for DELETE." });
    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET,POST}' WHERE id = $1`, [tableResource]);
    try {
      const dataview = await custom("tc-ok", [tableCall(tableResource, "CREATE")]);
      // The runtime writes through the Data API, by schema and name.
      expect(dataview.variableResources).toEqual({ [tableResource]: { schema: "public", name: TABLE, type: "TABLE", columns: expect.any(Object) } });
    } finally {
      await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET}' WHERE id = $1`, [tableResource]);
    }
  });

  it("places widgets on the canvas and in a slot of another widget, bound to the variables", async () => {
    const dataview = await custom("widgets");
    const card = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard" });
    const select = await dataviewsAdmin.addWidget(dataview.id, {
      widget: "USelectMenu",
      parent: card.id,
      config: {
        slot: "default",
        props: { labelKey: "nombre" },
        bindings: { modelValue: { kind: "variable", variable: "cliente" }, items: { kind: "variable", variable: "clientes" } },
        emits: { "update:modelValue": "onClienteChange" },
      },
    });
    expect(select).toMatchObject({ kind: "WIDGET", widget: "USelectMenu", parent: card.id });
    const second = await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", parent: card.id, config: { slot: "default" } });
    expect(second.gridY).toBe(1); // below its sibling in the same slot
  });

  it("refuses an unknown widget, a config that doesn't fit, and a bad placement", async () => {
    const dataview = await custom("refusals");
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UChart" })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", config: { props: { labell: "x" } } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_INVALID",
    });
    await expect(
      dataviewsAdmin.addWidget(dataview.id, { widget: "USelectMenu", config: { bindings: { modelValue: { kind: "variable", variable: "clientes" } } } }),
    ).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID", message: "Select menu's Value needs a VALUE variable." });
    const button = await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton" });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", parent: button.id, config: { slot: "default" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
      message: "Button has no area to place widgets in.",
    });
    const card = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard" });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", parent: card.id, config: { slot: "sidebar" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
    });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", config: { slot: "default" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
    });
  });

  it("places buttons and menus in a CUSTOM page's header - nothing else, and nowhere else", async () => {
    const dataview = await custom("header");
    const button = await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", config: { slot: "header" } });
    expect(button.parent).toBeNull();
    // Its own order, apart from the page's widgets.
    await dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge" });
    expect((await dataviewsAdmin.addWidget(dataview.id, { widget: "UDropdownMenu", config: { slot: "header" } })).gridY).toBe(1);
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", config: { slot: "header" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
      message: "The page header takes buttons and menus, not a Badge.",
    });
    // Moved there from the page, and back.
    const other = await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton" });
    expect((await dataviewsAdmin.updateField(dataview.id, other.id, { config: { slot: "header" } })).config).toMatchObject({ slot: "header" });
    // A record form's page has the App's own header.
    const table = await dataviewsAdmin.create({ name: "Custom header table", slug: `${PREFIX}-ht`, viewType: "FORM", sourceResourceId: tableResource });
    await expect(dataviewsAdmin.addWidget(table.id, { widget: "UButton", config: { slot: "header" } })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_SLOT_INVALID" });
  });

  it("places buttons, menus, text, badges and boxes in a CUSTOM page's footer - a box holding anything", async () => {
    const dataview = await custom("footer");
    const box = await dataviewsAdmin.addWidget(dataview.id, { widget: "TBox", config: { slot: "footer" } });
    expect(box.parent).toBeNull();
    // Its own order, apart from the page's and the header's.
    await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", config: { slot: "header" } });
    expect((await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", config: { slot: "footer" } })).gridY).toBe(1);
    for (const widget of ["UDropdownMenu", "TText", "UBadge"] as const) {
      await dataviewsAdmin.addWidget(dataview.id, { widget, config: { slot: "footer" } });
    }
    // A Box in the footer holds anything - totals as form fields, say.
    await dataviewsAdmin.addWidget(dataview.id, { widget: "UInputNumber", parent: box.id, config: { slot: "default" } });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UTable", config: { slot: "footer" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
      message: "The page footer takes buttons, menus, text, badges and boxes, not a Table.",
    });
    // A record form's page has its own footer - Cancel and Save.
    const form = await dataviewsAdmin.create({ name: "Custom footer form", slug: `${PREFIX}-ft`, viewType: "FORM", sourceResourceId: tableResource });
    await expect(dataviewsAdmin.addWidget(form.id, { widget: "UButton", config: { slot: "footer" } })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_SLOT_INVALID" });
  });

  it("keeps an embedded DataView as a foreign key - it can't be deleted while a page shows it", async () => {
    const page = await custom("dt");
    const target = await dataviewsAdmin.create({ name: "Custom dt rows", slug: `${PREFIX}-dt-rows`, viewType: "TABLE", sourceResourceId: tableResource });
    const detail = await dataviewsAdmin.addWidget(page.id, { widget: "TDataView", config: { props: { dataview: target.id, column: "factura" } } });
    expect(detail.relatedDataview).toBe(target.id);
    await expect(dataviewsAdmin.delete(target.id)).rejects.toMatchObject({ code: "FOREIGN_KEY_VIOLATION" });
    // Pointing it elsewhere, or nowhere, moves the key with it.
    const cleared = await dataviewsAdmin.updateField(page.id, detail.id, { config: { props: { column: "factura" } } });
    expect(cleared.relatedDataview).toBeNull();
    await dataviewsAdmin.delete(target.id);
  });

  it("embeds a list DataView (TDataView) - never a page - and owns nothing: removing it never deletes its DataView", async () => {
    const page = await custom("emb");
    const list = await dataviewsAdmin.create({ name: "Custom emb list", slug: `${PREFIX}-emb-list`, viewType: "TABLE", sourceResourceId: tableResource });
    const otherPage = await custom("emb-page");
    await expect(dataviewsAdmin.addWidget(page.id, { widget: "TDataView", config: { props: { dataview: otherPage.id } } }))
      .rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });

    const embed = await dataviewsAdmin.addWidget(page.id, { widget: "TDataView", config: { props: { dataview: list.id, readOnly: true } } });
    expect(embed.relatedDataview).toBe(list.id);
    // Its View is one the DataView offers - its view_type, or one of its layouts.
    await expect(dataviewsAdmin.updateField(page.id, embed.id, { config: { props: { dataview: list.id, view: "CARDS" } } }))
      .rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });
    await dataviewsAdmin.update(list.id, { viewConfig: { layouts: ["TABLE", "CARDS"] } });
    await dataviewsAdmin.updateField(page.id, embed.id, { config: { props: { dataview: list.id, view: "CARDS", toolbarMode: "none", allow: ["create"] } } });
    await expect(dataviewsAdmin.updateField(page.id, embed.id, { config: { props: { dataview: otherPage.id } } }))
      .rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });

    // Left out of the App menu (EMBEDDED_ONLY), it's still the author's: removing the embed, or the page, keeps it.
    await database.query(`UPDATE totalbase.dataviews SET scope = 'EMBEDDED_ONLY' WHERE id = $1`, [list.id]);
    await dataviewsAdmin.deleteField(page.id, embed.id);
    await dataviewsAdmin.addWidget(page.id, { widget: "TDataView", config: { props: { dataview: list.id } } });
    await dataviewsAdmin.delete(page.id);
    expect((await dataviewsAdmin.get(list.id)).id).toBe(list.id);
  });

  it("never deletes a DataView an embed shows but doesn't own - hidden from the App menu or not", async () => {
    const page = await custom("own");
    const mine = await dataviewsAdmin.create({ name: "Custom own list", slug: `${PREFIX}-own-list`, viewType: "TABLE", sourceResourceId: tableResource });
    // "Show in the App menu" off: EMBEDDED_ONLY, but nobody's detail - its author's own.
    await database.query(`UPDATE totalbase.dataviews SET scope = 'EMBEDDED_ONLY' WHERE id = $1`, [mine.id]);
    const detail = await dataviewsAdmin.addWidget(page.id, { widget: "TDataView", config: { props: { dataview: mine.id, column: "nombre" } } });
    await dataviewsAdmin.deleteField(page.id, detail.id);
    expect((await dataviewsAdmin.get(mine.id)).id).toBe(mine.id);
    await dataviewsAdmin.addWidget(page.id, { widget: "TDataView", config: { props: { dataview: mine.id, column: "nombre" } } });
    await dataviewsAdmin.delete(page.id);
    expect((await dataviewsAdmin.get(mine.id)).id).toBe(mine.id);
  });

  it("embeds a Dashboard (TDashboard) as a foreign key, its variables set by formulas", async () => {
    const page = await custom("dash");
    const dashboard = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.dashboards (name, slug) VALUES ('Custom dash', '${PREFIX}-dash') RETURNING id`,
    )).rows[0]!.id;
    try {
      const widget = await dataviewsAdmin.addWidget(page.id, { widget: "TDashboard", config: { props: { dashboard, variables: { customer: "{{vars.cliente}}" } } } });
      expect(widget.relatedDashboard).toBe(dashboard);
      await expect(database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboard])).rejects.toMatchObject({ code: "FOREIGN_KEY_VIOLATION" });
      // A variable's formula is text; anything else doesn't fit.
      await expect(dataviewsAdmin.updateField(page.id, widget.id, { config: { props: { dashboard, variables: { customer: 1 } } } }))
        .rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });
      const cleared = await dataviewsAdmin.updateField(page.id, widget.id, { config: { props: {} } });
      expect(cleared.relatedDashboard).toBeNull();
    } finally {
      await dataviewsAdmin.delete(page.id);
      await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboard]);
    }
  });

  it("puts only an input in a form field", async () => {
    const dataview = await custom("fld-in");
    const field = await dataviewsAdmin.addWidget(dataview.id, { widget: "UFormField", config: { props: { label: "Nombre" } } });
    await dataviewsAdmin.addWidget(dataview.id, { widget: "UInput", parent: field.id, config: { slot: "default" } });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UFormField", parent: field.id, config: { slot: "default" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
      message: "Form field's Input holds an input, not a Form field.",
    });
    const button = await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton" });
    await expect(dataviewsAdmin.updateField(dataview.id, button.id, { parent: field.id, config: { slot: "default" } })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_SLOT_INVALID" });
  });

  it("puts one input in a form field - a second is refused, placed or moved in", async () => {
    const dataview = await custom("fld-one");
    const field = await dataviewsAdmin.addWidget(dataview.id, { widget: "UFormField", config: { props: { label: "Nombre" } } });
    const input = await dataviewsAdmin.addWidget(dataview.id, { widget: "UInput", parent: field.id, config: { slot: "default" } });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UTextarea", parent: field.id, config: { slot: "default" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
      message: "Form field's Input already holds its input - one input per field.",
    });
    const loose = await dataviewsAdmin.addWidget(dataview.id, { widget: "UInput" });
    await expect(dataviewsAdmin.updateField(dataview.id, loose.id, { parent: field.id, config: { slot: "default" } })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_SLOT_INVALID" });
    // The input already there still changes.
    await dataviewsAdmin.updateField(dataview.id, input.id, { config: { slot: "default", props: { type: "email" } } });
  });

  it("keeps a Tabs' content per tab, and a per-item slot only as <slot>:<key>", async () => {
    const dataview = await custom("per-item");
    const tabs = await dataviewsAdmin.addWidget(dataview.id, { widget: "UTabs" });
    const first = await dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", parent: tabs.id, config: { slot: "content:tab1" } });
    expect(first.config).toMatchObject({ slot: "content:tab1" });
    for (const slot of ["content", "content:", "header:tab1"]) {
      await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", parent: tabs.id, config: { slot } })).rejects.toMatchObject({
        code: "DATAVIEW_WIDGET_SLOT_INVALID",
      });
    }
    const card = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard" });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", parent: card.id, config: { slot: "default:x" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
    });
    // A Columns' columns the same: one area per column, never the bare slot.
    const columns = await dataviewsAdmin.addWidget(dataview.id, { widget: "TColumns" });
    expect(columns.config).toMatchObject({ props: { items: [{ value: "col1", span: 4 }, { value: "col2", span: 4 }, { value: "col3", span: 4 }] } });
    const inColumn = await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", parent: columns.id, config: { slot: "column:col2" } });
    expect(inColumn.config).toMatchObject({ slot: "column:col2" });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", parent: columns.id, config: { slot: "column" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
    });
  });

  it("places a button at Fit content and an input at the whole row, and refuses Fit content on what fills", async () => {
    const dataview = await custom("widths");
    const button = await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton" });
    expect(button.gridW).toBe(0);
    const input = await dataviewsAdmin.addWidget(dataview.id, { widget: "UInput" });
    expect(input.gridW).toBe(12);
    await dataviewsAdmin.updateField(dataview.id, button.id, { gridW: 6 });
    await dataviewsAdmin.updateField(dataview.id, button.id, { gridW: 0 });
    for (const gridW of [13, -1, 2.5]) {
      await expect(dataviewsAdmin.updateField(dataview.id, input.id, { gridW })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });
    }
    await expect(dataviewsAdmin.updateField(dataview.id, input.id, { gridW: 0 })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });
    await expect(dataviewsAdmin.addWidget(dataview.id, { widget: "UCard", gridW: 0 })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });
  });

  it("places widgets on a page - CUSTOM, a FORM, a grid's record form - never on an external frame", async () => {
    const frame = await dataviewsAdmin.create({ name: "Custom frame", slug: `${PREFIX}-frame`, viewType: "EXTERNALFRAME", viewConfig: { frame_url: "https://example.com" } });
    await expect(dataviewsAdmin.addWidget(frame.id, { widget: "UButton" })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_NOT_ALLOWED" });
    // A grid's record form is generated with it: a form over its record.
    const table = await dataviewsAdmin.create({ name: "Custom table", slug: `${PREFIX}-table`, viewType: "TABLE", sourceResourceId: tableResource });
    const tableFields = await dataviewsAdmin.listFields(table.id);
    expect(tableFields.filter((f) => f.widget === "UFormField").map((f) => (f.config as { props: { column: string } }).props.column)).toEqual(["id", "nombre"]);
    expect(tableFields.some((f) => f.widget === "UButton")).toBe(false);
    const form = await dataviewsAdmin.create({ name: "Custom form", slug: `${PREFIX}-form`, viewType: "FORM", sourceResourceId: tableResource });
    const field = await dataviewsAdmin.addWidget(form.id, { widget: "UFormField", config: { props: { column: "nombre" } } });
    expect(field.kind).toBe("WIDGET");
  });

  it("updates a widget's config and placement with the same rules, never into itself", async () => {
    const dataview = await custom("update");
    const outer = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard" });
    const inner = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard", parent: outer.id, config: { slot: "default" } });
    const updated = await dataviewsAdmin.updateField(dataview.id, inner.id, { config: { slot: "footer", props: { variant: "soft" } } });
    expect(updated.config).toEqual({ slot: "footer", props: { variant: "soft" } });
    await expect(dataviewsAdmin.updateField(dataview.id, inner.id, { config: { slot: "footer", props: { variant: "loud" } } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_INVALID",
    });
    await expect(dataviewsAdmin.updateField(dataview.id, outer.id, { parent: inner.id, config: { slot: "default" } })).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_SLOT_INVALID",
      message: "A widget can't be placed inside itself.",
    });
    await expect(dataviewsAdmin.updateField(dataview.id, inner.id, { widget: "UButton" })).rejects.toMatchObject({ code: "DATAVIEW_WIDGET_INVALID" });
    // Back to the canvas: no parent, no slot.
    const moved = await dataviewsAdmin.updateField(dataview.id, inner.id, { parent: null, config: {} });
    expect(moved.parent).toBeNull();
  });

  it("deletes a widget with everything in its slots - and a whole DataView with its widgets", async () => {
    const dataview = await custom("delete");
    const modal = await dataviewsAdmin.addWidget(dataview.id, { widget: "UModal" });
    const card = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard", parent: modal.id, config: { slot: "body" } });
    await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", parent: card.id, config: { slot: "footer" } });
    await dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge" });
    await dataviewsAdmin.deleteField(dataview.id, modal.id);
    expect((await dataviewsAdmin.listFields(dataview.id)).map((f) => f.widget)).toEqual(["UBadge"]);
    // Regression: a BEFORE DELETE trigger cascading by hand collided with the DataView's own cascade.
    const nested = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard" });
    await dataviewsAdmin.addWidget(dataview.id, { widget: "UButton", parent: nested.id, config: { slot: "footer" } });
    await dataviewsAdmin.delete(dataview.id);
    expect((await database.query(`SELECT 1 FROM totalbase.dataviews_fields WHERE dataview = $1`, [dataview.id])).rows).toHaveLength(0);
  });

  it("publishes only when every widget still fits the variables", async () => {
    const dataview = await custom("publish");
    await dataviewsAdmin.addWidget(dataview.id, {
      widget: "UInputNumber",
      config: { bindings: { modelValue: { kind: "variable", variable: "cliente" } } },
    });
    expect((await dataviewsAdmin.publish(dataview.id, null)).version).toBe(1);
    // Regression: the snapshot's column list left out `parent`, so a published page drew every widget at its root.
    const card = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard" });
    const inside = await dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", parent: card.id, config: { slot: "default" } });
    await dataviewsAdmin.publish(dataview.id, null);
    expect((await dataviewsAdmin.listPublishedFields(dataview.id)).find((f) => f.id === inside.id)?.parent).toBe(card.id);
    // Regression: restoring a version reinserted its fields without `parent` - every widget back at the root.
    await dataviewsAdmin.deleteField(dataview.id, card.id);
    await dataviewsAdmin.restore(dataview.id, 2);
    expect((await dataviewsAdmin.listFields(dataview.id)).find((f) => f.id === inside.id)?.parent).toBe(card.id);
    expect((await dataviewsAdmin.getWithStatus(dataview.id)).hasUnpublishedChanges).toBe(false);
    // The bound variable goes away: saving the variables is allowed, publishing isn't.
    await dataviewsAdmin.update(dataview.id, { viewConfig: { variables: [] } });
    await expect(dataviewsAdmin.publish(dataview.id, null)).rejects.toMatchObject({
      code: "DATAVIEW_WIDGET_INVALID",
      message: "Number's Value is bound to a variable that doesn't exist.",
    });
  });
});
