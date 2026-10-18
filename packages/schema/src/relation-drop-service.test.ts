import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RelationDropService } from "./relation-drop-service.js";

const TABLE = "relation_drop_pkg_test_table";
const VIEW = "relation_drop_pkg_test_view";
const FN = "relation_drop_pkg_test_fn";

describe("RelationDropService (integration)", () => {
  let database: Database;
  let dropService: RelationDropService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    dropService = new RelationDropService(database);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP FUNCTION IF EXISTS public.${FN}()`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id integer PRIMARY KEY)`);
  });

  afterAll(async () => {
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP FUNCTION IF EXISTS public.${FN}()`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.close();
  });

  it("drops a view by oid", async () => {
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT id FROM public.${TABLE}`);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${VIEW}`]);
    const oid = rows[0]!.oid;

    await dropService.dropView(oid);

    const { rows: check } = await database.query(`SELECT 1 FROM pg_class WHERE oid = $1`, [oid]);
    expect(check).toHaveLength(0);
  });

  it("drops a function by oid, resolving overload signature via regprocedure", async () => {
    await database.query(`CREATE FUNCTION public.${FN}() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql`);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regprocedure::oid::int AS oid`, [`public.${FN}()`]);
    const oid = rows[0]!.oid;

    await dropService.dropFunction(oid);

    const { rows: check } = await database.query(`SELECT 1 FROM pg_proc WHERE oid = $1`, [oid]);
    expect(check).toHaveLength(0);
  });

  it("rejects a non-positive oid without hitting the database", async () => {
    await expect(dropService.dropView(0)).rejects.toThrow(TotalBaseError);
    await expect(dropService.dropFunction(-1)).rejects.toThrow(TotalBaseError);
  });

  it("propagates a PostgreSQL error for an oid that doesn't exist", async () => {
    await expect(dropService.dropView(999999999)).rejects.toThrow();
  });
});
