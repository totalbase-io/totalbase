import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataViewsAdminService } from "./dataviews-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const MASTER = "dataviews_md_test_orders";
const DETAIL = "dataviews_md_test_order_lines";
const UNRELATED = "dataviews_md_test_notes";

/**
 * MASTER_DETAIL DataViews: the detail comes from a real FK to the master,
 * the master is created with a Detail control over a detail DataView it
 * owns - published with it, counted in its unpublished changes, deleted
 * with it.
 */
describe("MASTER_DETAIL DataViews (integration)", () => {
  let database: Database;
  let dataviewsAdmin: DataViewsAdminService;
  let masterResourceId: string;
  let detailResourceId: string;
  let unrelatedResourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dataviewsAdmin = new DataViewsAdminService(database);

    await database.query(`DROP TABLE IF EXISTS public.${DETAIL}, public.${MASTER}, public.${UNRELATED} CASCADE`);
    await database.query(`
      CREATE TABLE public.${MASTER} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        customer text NOT NULL DEFAULT 'Walk-in',
        placed_on date NOT NULL DEFAULT current_date,
        total numeric(12,2) NOT NULL DEFAULT 0
      )
    `);
    await database.query(`
      CREATE TABLE public.${DETAIL} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "order" bigint NOT NULL REFERENCES public.${MASTER} (id) ON DELETE CASCADE,
        product text NOT NULL,
        quantity numeric NOT NULL DEFAULT 1
      )
    `);
    await database.query(`CREATE TABLE public.${UNRELATED} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text)`);

    const register = async (name: string) => {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
         VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
        [`public.${name}`, name],
      );
      return rows[0]!.id;
    };
    masterResourceId = await register(MASTER);
    detailResourceId = await register(DETAIL);
    unrelatedResourceId = await register(UNRELATED);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = ANY($1) AND scope = 'LISTED'`, [
      [masterResourceId, detailResourceId, unrelatedResourceId],
    ]);
    await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = ANY($1)`, [
      [masterResourceId, detailResourceId, unrelatedResourceId],
    ]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [
      [masterResourceId, detailResourceId, unrelatedResourceId],
    ]);
    await database.query(`DROP TABLE IF EXISTS public.${DETAIL}, public.${MASTER}, public.${UNRELATED} CASCADE`);
    await database.close();
  });

  it("lists the tables whose FK points at the master", async () => {
    const candidates = await dataviewsAdmin.listDetailCandidates(masterResourceId);
    expect(candidates).toEqual([{ resourceId: detailResourceId, schema: "public", table: DETAIL, fkColumn: "order" }]);
    expect(await dataviewsAdmin.listDetailCandidates(unrelatedResourceId)).toEqual([]);
  });

  it("refuses a detail that doesn't reference the master, or none at all", async () => {
    await expect(
      dataviewsAdmin.create({ name: "MD refused", viewType: "MASTER_DETAIL", sourceResourceId: masterResourceId }),
    ).rejects.toMatchObject({ code: "DATAVIEW_DETAIL_REQUIRED" });
    await expect(
      dataviewsAdmin.create({
        name: "MD refused",
        viewType: "MASTER_DETAIL",
        sourceResourceId: masterResourceId,
        detail: { resourceId: unrelatedResourceId, fkColumn: "id" },
      }),
    ).rejects.toMatchObject({ code: "DATAVIEW_DETAIL_INVALID" });
  });

  it("creates the master with a generated page: every column by default, a Detail over a detail DataView it owns - Save & New is its frame's", async () => {
    const master = await dataviewsAdmin.create({
      name: "MD orders",
      viewType: "MASTER_DETAIL",
      sourceResourceId: masterResourceId,
      detail: { resourceId: detailResourceId, fkColumn: "order" },
    });
    expect(master.viewType).toBe("MASTER_DETAIL");

    const fields = await dataviewsAdmin.listFields(master.id);
    const visibleColumns = fields.filter((f) => f.kind === "COLUMN" && f.visible);
    // Every column, unless the wizard's Columns step says otherwise - the key too, read-only on the form.
    expect(visibleColumns.map((f) => f.columnName)).toEqual(["id", "customer", "placed_on", "total"]);
    // No title of their own: each inherits its column's, else its name humanized (Specification_DataViews.md §15).
    expect(visibleColumns.map((f) => f.label)).toEqual([null, null, null, null]);

    // Its record form is a page (Specification_DataViews.md §6.1): a form over the record...
    const form = fields.find((f) => f.widget === "UForm")!;
    const inForm = fields.filter((f) => f.parent === form.id).sort((a, b) => a.gridY - b.gridY);
    expect(inForm.map((f) => f.widget)).toEqual(["UFormField", "UFormField", "UFormField", "UFormField", "TDataView"]);
    expect(inForm.slice(0, 4).map((f) => (f.config as { props: { column: string } }).props.column)).toEqual(["id", "customer", "placed_on", "total"]);
    // ...its Detail over the detail DataView, and the Code it runs.
    const control = inForm[4]!;
    expect(control).toMatchObject({ config: { props: { column: "order" }, emits: { rowsChanged: "onDetailRowsChanged" } }, gridW: 12 });
    const page = await dataviewsAdmin.get(master.id);
    expect(page.code).toContain("async function onDetailRowsChanged(dataview, event)");

    const detail = await dataviewsAdmin.get(control.relatedDataview!);
    expect(detail).toMatchObject({ viewType: "TABLE", scope: "EMBEDDED_ONLY", name: "MD orders - Dataviews md test", slug: "md-orders-detail" });
    // Its lines in the order they were entered: the identity, never the master's "order" foreign key (B54).
    expect(detail.viewConfig).toMatchObject({ edit_presentation: "MODAL", default_state: { sort: "id" } });
    const detailColumns = (await dataviewsAdmin.listFields(detail.id)).filter((f) => f.kind === "COLUMN" && f.visible);
    // Every column but the one pointing at the master - the Detail fills that in.
    expect(detailColumns.map((f) => f.columnName)).toEqual(["id", "product", "quantity"]);
  });

  it("starts the form and the detail from the columns the wizard kept, titled by their columns", async () => {
    const master = await dataviewsAdmin.create({
      name: "MD picked",
      viewType: "MASTER_DETAIL",
      sourceResourceId: masterResourceId,
      selectedColumns: ["customer", "total"],
      detail: { resourceId: detailResourceId, fkColumn: "order", selectedColumns: ["quantity"] },
    });
    const fields = await dataviewsAdmin.listFields(master.id);
    const bound = fields.filter((f) => f.widget === "UFormField").map((f) => (f.config as { props: { column: string; label: string } }).props);
    // Each inherits its column's title (Specification_DataViews.md §15) - none stored.
    expect(bound).toEqual([{ column: "customer" }, { column: "total" }]);
    const detailId = fields.find((f) => f.widget === "TDataView")!.relatedDataview!;
    const detailColumns = (await dataviewsAdmin.listFields(detailId)).filter((f) => f.kind === "COLUMN" && f.visible);
    expect(detailColumns.map((f) => [f.columnName, f.label])).toEqual([["quantity", null]]);
    await dataviewsAdmin.delete(master.id);
  });

  it("publishes its detail form with it, and counts the detail's changes as its own", async () => {
    const master = (await dataviewsAdmin.list()).find((d) => d.name === "MD orders")!;
    const control = (await dataviewsAdmin.listFields(master.id)).find((f) => f.widget === "TDataView")!;
    const detailId = control.relatedDataview!;

    await dataviewsAdmin.publish(master.id, null);
    expect(await dataviewsAdmin.listVersions(detailId)).toHaveLength(1);
    expect(await dataviewsAdmin.hasUnpublishedChanges(master.id)).toBe(false);

    const product = (await dataviewsAdmin.listFields(detailId)).find((f) => f.columnName === "product")!;
    await dataviewsAdmin.updateField(detailId, product.id, { gridW: 5 });
    expect(await dataviewsAdmin.hasUnpublishedChanges(master.id)).toBe(true);

    await dataviewsAdmin.publish(master.id, null);
    expect(await dataviewsAdmin.listVersions(detailId)).toHaveLength(2);
    expect(await dataviewsAdmin.hasUnpublishedChanges(master.id)).toBe(false);
  });

  it("deletes its detail DataView with it", async () => {
    const master = (await dataviewsAdmin.list()).find((d) => d.name === "MD orders")!;
    const detailId = (await dataviewsAdmin.listFields(master.id)).find((f) => f.widget === "TDataView")!.relatedDataview!;
    await dataviewsAdmin.delete(master.id);
    await expect(dataviewsAdmin.get(detailId)).rejects.toMatchObject({ code: "DATAVIEW_NOT_FOUND" });
  });

  it("deletes an EMBEDDED_ONLY DataView once the last Detail of it is removed - or the form holding it", async () => {
    const master = await dataviewsAdmin.create({
      name: "MD orders two",
      viewType: "MASTER_DETAIL",
      sourceResourceId: masterResourceId,
      detail: { resourceId: detailResourceId, fkColumn: "order" },
    });
    const control = (await dataviewsAdmin.listFields(master.id)).find((f) => f.widget === "TDataView")!;
    await dataviewsAdmin.deleteField(master.id, control.id);
    await expect(dataviewsAdmin.get(control.relatedDataview!)).rejects.toMatchObject({ code: "DATAVIEW_NOT_FOUND" });
    await dataviewsAdmin.delete(master.id);

    // Its form, deleted with what it holds (ON DELETE CASCADE), takes the Detail's DataView too.
    const third = await dataviewsAdmin.create({
      name: "MD orders three",
      viewType: "MASTER_DETAIL",
      sourceResourceId: masterResourceId,
      detail: { resourceId: detailResourceId, fkColumn: "order" },
    });
    const thirdFields = await dataviewsAdmin.listFields(third.id);
    const detailId = thirdFields.find((f) => f.widget === "TDataView")!.relatedDataview!;
    await dataviewsAdmin.deleteField(third.id, thirdFields.find((f) => f.widget === "UForm")!.id);
    await expect(dataviewsAdmin.get(detailId)).rejects.toMatchObject({ code: "DATAVIEW_NOT_FOUND" });
    await dataviewsAdmin.delete(third.id);
  });
});
