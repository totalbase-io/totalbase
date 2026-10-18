import { fileURLToPath } from "node:url";
import { relationDetailCache } from "@totalbase/pg-catalog";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResourcesAdminService } from "./resources-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "colpres_test_items";
const VIEW = "colpres_test_items_view";

// A column's presentation (Specification_DataViews.md §15), against a real table and view.
describe("ResourcesAdminService column presentation (integration)", () => {
  let database: Database;
  let service: ResourcesAdminService;
  let tableId: string;
  let viewId: string;
  let functionId: string;

  async function register(name: string, type: "TABLE" | "VIEW"): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1::regclass::oid, 'public', $2, $3, 'ACTIVE') RETURNING id`,
      [`public.${name}`, name, type],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    service = new ResourcesAdminService(database);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(
      `CREATE TABLE public.${TABLE} (
         id serial PRIMARY KEY,
         precio_unitario numeric(10,2),
         activo boolean,
         estado text CHECK (estado IN ('A', 'I')),
         email text
       )`,
    );
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT id, precio_unitario FROM public.${TABLE}`);
    tableId = await register(TABLE, "TABLE");
    viewId = await register(VIEW, "VIEW");
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, function_class)
       VALUES (900301, 'public', 'colpres_test_fn', 'FUNCTION', 'ACTIVE', 'UNCLASSIFIED') RETURNING id`,
    );
    functionId = rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id IN ($1, $2, $3)`, [tableId, viewId, functionId]);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.close();
  });

  it("gives a view's column its table column's presentation, under the view's own - an expression none (T67 first step)", async () => {
    const view2 = `${VIEW}_calc`;
    await database.query(`CREATE VIEW public.${view2} AS SELECT v.id, v.precio_unitario, v.precio_unitario * 2 AS doble FROM public.${VIEW} v`);
    const view2Id = await register(view2, "VIEW");
    try {
      await service.updateColumnPresentations(tableId, { precio_unitario: { label: "Precio", displayFormat: "#,##0.00" }, id: { label: "Número" } });
      const effective = async (id: string) =>
        (await database.query<{ p: Record<string, Record<string, unknown>> }>(`SELECT totalbase.resource_column_presentation($1) AS p`, [id])).rows[0]!.p;
      // Through a view over a view, as PostgreSQL recorded each column's origin.
      expect(await effective(view2Id)).toEqual({ id: { label: "Número" }, precio_unitario: { label: "Precio", displayFormat: "#,##0.00" } });
      // The view's own wins, key by key.
      await service.updateColumnPresentations(view2Id, { precio_unitario: { label: "Precio de lista" } });
      expect((await effective(view2Id)).precio_unitario).toEqual({ label: "Precio de lista", displayFormat: "#,##0.00" });
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [view2Id]);
      await database.query(`DROP VIEW IF EXISTS public.${view2}`);
    }
  });

  it("sets a column's presentation, writing its row", async () => {
    const saved = await service.updateColumnPresentation(tableId, "precio_unitario", { label: " Precio unitario ", displayFormat: "#,##0.00" });
    expect(saved).toEqual({ columnName: "precio_unitario", presentation: { label: "Precio unitario", displayFormat: "#,##0.00" } });
    expect(await service.listColumns(tableId)).toContainEqual(expect.objectContaining(saved));
  });

  it("replaces it whole, leaving the rest of the config alone", async () => {
    await database.query(
      `UPDATE totalbase.resources_columns SET config = config || '{"other": 1}'::jsonb WHERE resource = $1 AND name = 'precio_unitario'`,
      [tableId],
    );
    const saved = await service.updateColumnPresentation(tableId, "precio_unitario", { description: "Sin IVA" });
    expect(saved.presentation).toEqual({ description: "Sin IVA" });
    const { rows } = await database.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM totalbase.resources_columns WHERE resource = $1 AND name = 'precio_unitario'`,
      [tableId],
    );
    expect(rows[0]!.config).toEqual({ description: "Sin IVA", other: 1 });
  });

  it("takes only the options the column's type takes", async () => {
    await expect(service.updateColumnPresentation(tableId, "email", { displayFormat: "dd/MM/yyyy" })).rejects.toMatchObject({
      code: "INVALID_COLUMN_PRESENTATION",
    });
    await expect(service.updateColumnPresentation(tableId, "precio_unitario", { min: 0 })).rejects.toMatchObject({
      code: "INVALID_COLUMN_PRESENTATION",
    });
    expect((await service.updateColumnPresentation(tableId, "activo", { booleanLabels: { true: "Sí", false: "No" } })).presentation).toEqual({
      booleanLabels: { true: "Sí", false: "No" },
    });
    expect((await service.updateColumnPresentation(tableId, "email", { linkType: "email" })).presentation).toEqual({ linkType: "email" });
    expect((await service.updateColumnPresentation(tableId, "estado", { options: { A: { label: "Activo", color: "success" }, I: { label: "Inactivo" } } })).presentation).toEqual({
      options: { A: { label: "Activo", color: "success" }, I: { label: "Inactivo" } },
    });
    expect((await service.updateColumnPresentation(tableId, "precio_unitario", { icon: "i-lucide-dollar-sign", iconPosition: "trailing" })).presentation).toEqual({
      icon: "i-lucide-dollar-sign",
      iconPosition: "trailing",
    });
  });

  it("sets a view's column too", async () => {
    const saved = await service.updateColumnPresentation(viewId, "precio_unitario", { label: "Precio" });
    expect(saved.presentation).toEqual({ label: "Precio" });
  });

  it("keeps a column's presentation across a rename - its identity is the attnum", async () => {
    await service.updateColumnPresentation(tableId, "email", { label: "Correo" });
    await database.query(`ALTER TABLE public.${TABLE} RENAME COLUMN email TO correo`);
    relationDetailCache.clear(); // raw DDL: in the product a reconcile follows every schema change and clears it
    const saved = await service.updateColumnPresentation(tableId, "correo", { label: "Correo", linkType: "email" });
    expect(saved).toMatchObject({ columnName: "correo", presentation: { label: "Correo", linkType: "email" } });
    const { rows } = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM totalbase.resources_columns WHERE resource = $1 AND name IN ('email', 'correo')`,
      [tableId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("refuses an unknown column and a function", async () => {
    await expect(service.updateColumnPresentation(tableId, "nope", { label: "x" })).rejects.toMatchObject({ code: "UNDEFINED_COLUMN" });
    await expect(service.updateColumnPresentation(functionId, "x", { label: "x" })).rejects.toMatchObject({ code: "INVALID_COLUMN_PRESENTATION" });
  });
});
