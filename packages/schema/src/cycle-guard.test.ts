import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TableSchemaService } from "./table-schema-service.js";

const T = "schema_pkg_cycle_guard_test";

// A TREE DataView's table (Specification_DataViews.md §5.14): PostgreSQL itself refuses a row under itself, at any depth.
describe("cycle guard (integration)", () => {
  let database: Database;
  let service: TableSchemaService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    service = new TableSchemaService(database);
    await database.query(`DROP TABLE IF EXISTS public.${T} CASCADE`);
    await database.query(`CREATE TABLE public.${T} (id integer PRIMARY KEY, jefe integer REFERENCES public.${T} (id))`);
    await database.query(`INSERT INTO public.${T} VALUES (1, NULL), (2, 1), (3, 2)`);
    await service.addCycleGuard("public", T, "jefe");
    // Offered again: harmless.
    await service.addCycleGuard("public", T, "jefe");
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${T} CASCADE`);
    await database.query(`DROP FUNCTION IF EXISTS public.${T}_jefe_no_cycle()`);
    await database.close();
  });

  it("refuses a row under itself or under its own descendant, and lets every other move through", async () => {
    await expect(database.query(`UPDATE public.${T} SET jefe = 1 WHERE id = 1`)).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    await expect(database.query(`UPDATE public.${T} SET jefe = 3 WHERE id = 1`)).rejects.toMatchObject({ message: expect.stringContaining("under itself") });
    await database.query(`UPDATE public.${T} SET jefe = 1 WHERE id = 3`);
    await database.query(`INSERT INTO public.${T} VALUES (4, 3)`);
    await database.query(`UPDATE public.${T} SET jefe = NULL WHERE id = 2`);
  });
});
