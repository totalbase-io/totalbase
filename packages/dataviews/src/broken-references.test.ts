import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brokenDataViewReferences, filterColumns, formulaColumns } from "./broken-references.js";
import { DataViewsAdminService } from "./dataviews-admin-service.js";
import { relationDetailCache } from "@totalbase/pg-catalog";

// Integration tests change tables with raw SQL (ALTER/RENAME/DROP COLUMN); in the product every schema change
// goes through a reconcile that clears the relation-detail cache, so here it is simply off.
relationDetailCache.enabled = false;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "broken_refs_test_people";

describe("what a formula and a filter name", () => {
  it("reads columns, not variables, and a related column's first step", () => {
    expect(formulaColumns('CONCATENATE({{apellido}}, ", ", {{ nombre }}) + {{vars.x}} + {{municipio.nombre}}')).toEqual(["apellido", "nombre", "municipio"]);
    expect(filterColumns({ _and: [{ vigente: { _eq: "true" } }, { _or: [{ "sucursal.nombre": { _ilike: "%x%" } }] }], _not: { dni: { _is_null: true } } }))
      .toEqual(["vigente", "sucursal", "dni"]);
  });
});

// DataViews.md §4.8: a dropped or renamed column a DataView still names.
describe("brokenDataViewReferences (integration)", () => {
  let database: Database;
  let dataviews: DataViewsAdminService;
  let resourceId: string;
  let dataviewId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dataviews = new DataViewsAdminService(database);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, apellido text, nombre text, vigente boolean, foto text)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      [`public.${TABLE}`, TABLE],
    );
    resourceId = rows[0]!.id;
    dataviewId = (await dataviews.create({
      name: "Broken refs people", slug: "broken-refs-people", sourceResourceId: resourceId, viewType: "CARDS",
      viewConfig: { card_layout: { titleFormula: "{{apellido}}, {{nombre}}", imageFormula: "{{foto}}" }, base_where: { vigente: { _eq: "true" } } },
    })).id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataviewId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.close();
  });

  const mine = async () => (await brokenDataViewReferences(database)).filter((b) => b.dataview.id === dataviewId);

  it("finds nothing while every column it names exists", async () => {
    expect(await mine()).toEqual([]);
  });

  it("names the layout formula and the filter whose column was dropped or renamed, and a column in Columns that was dropped", async () => {
    await database.query(`ALTER TABLE public.${TABLE} DROP COLUMN nombre`);
    await database.query(`ALTER TABLE public.${TABLE} RENAME COLUMN vigente TO activo`);
    expect((await mine()).map((b) => [b.part, b.column, b.version, b.resource])).toEqual([
      ["card_layout.titleFormula", "nombre", null, resourceId],
      ["base_where", "vigente", null, resourceId],
      // In Columns by attnum: a renamed column is still there, a dropped one is not.
      ["columns", "nombre", null, resourceId],
    ]);
  });

  it("names its source when the table itself is gone", async () => {
    await database.query(`UPDATE totalbase.resources SET status = 'MISSING' WHERE id = $1`, [resourceId]);
    expect((await mine()).map((b) => [b.part, b.column])).toEqual([["source", null]]);
    await database.query(`UPDATE totalbase.resources SET status = 'ACTIVE' WHERE id = $1`, [resourceId]);
  });
});
