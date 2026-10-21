import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResourcesAdminService } from "./resources-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "colsuggest_test_invoices";

// Suggest presentation (DataViews.md §15.6, T69): by type and constraints, against a real table.
describe("ResourcesAdminService suggested presentation (integration)", () => {
  let database: Database;
  let service: ResourcesAdminService;
  let tableId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    service = new ResourcesAdminService(database);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(
      `CREATE TABLE public.${TABLE} (
         id serial PRIMARY KEY,
         numero integer NOT NULL UNIQUE,
         cliente text NOT NULL UNIQUE,
         estado text NOT NULL CHECK (estado IN ('BORRADOR', 'EMITIDA')),
         cuit text CHECK (cuit ~ '^\\d{2}-\\d{8}-\\d$'),
         nota text
       )`,
    );
    await database.query(`COMMENT ON COLUMN public.${TABLE}.nota IS 'Lo que el operador anota.'`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [`public.${TABLE}`, TABLE],
    );
    tableId = rows[0]!.id;
    // A value of its own: a change offered, never ticked by default.
    await service.updateColumnPresentation(tableId, "nota", { label: "Nota", emptyText: "sin nota" });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [tableId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.close();
  });

  it("reviews a table: fills by type and constraints, a change marked as one, its row by its unique required text", async () => {
    const review = await service.suggestColumnPresentations(tableId);
    const by = Object.fromEntries(review.columns.map((c) => [c.columnName, Object.fromEntries(c.suggestions.map((s) => [s.key, { value: s.value, replaces: s.replaces }]))]));
    expect(by.numero).toEqual({ mono: { value: true, replaces: false } });
    expect(by.estado!.options!.value).toEqual({ BORRADOR: { label: "Borrador" }, EMITIDA: { label: "Emitida" } });
    expect(by.cuit).toMatchObject({ placeholder: { value: "12-34567890-1" }, mono: { value: true }, emptyText: { value: "—" } });
    expect(by.nota).toEqual({ description: { value: "Lo que el operador anota.", replaces: false }, emptyText: { value: "—", replaces: true } });
    expect(review.row).toEqual({ displayField: "cliente", reason: "unique-text" });
  });

  it("applies what the reviewer accepted - their edits included - and a row; filling never changes a value of its own", async () => {
    await service.applyPresentationReview(tableId, { columns: { numero: { mono: true, label: "Número" } }, row: { displayField: "cliente" } });
    const after = await service.suggestColumnPresentations(tableId);
    expect(after.columns.find((c) => c.columnName === "numero")).toBeUndefined();
    expect(after.row).toBeNull();

    await service.applyPresentationFills([tableId]);
    const columns = Object.fromEntries((await service.listColumns(tableId)).map((c) => [c.columnName, c.presentation]));
    expect(columns.nota).toEqual({ label: "Nota", emptyText: "sin nota", description: "Lo que el operador anota." });
    expect(columns.numero).toEqual({ mono: true, label: "Número" });
    // What's left differs only where the column has its own value.
    expect((await service.suggestColumnPresentations(tableId)).columns.flatMap((c) => c.suggestions).every((s) => s.replaces)).toBe(true);
  });
});
