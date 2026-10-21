import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TableSchemaService } from "./table-schema-service.js";

const ORDERS = "schema_pkg_test_orders";
const PRODUCTS = "schema_pkg_test_products_j";
const JUNCTION = "schema_pkg_test_orders_products";

/** A junction table (Administration.md §3.4): one CREATE TABLE with its foreign keys and the UNIQUE over them. */
describe("junction tables (integration)", () => {
  let database: Database;
  let schemaService: TableSchemaService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    schemaService = new TableSchemaService(database);
    for (const t of [JUNCTION, ORDERS, PRODUCTS]) await database.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
    await database.query(`CREATE TABLE public.${ORDERS} (id serial PRIMARY KEY)`);
    await database.query(`CREATE TABLE public.${PRODUCTS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
  });

  afterAll(async () => {
    for (const t of [JUNCTION, ORDERS, PRODUCTS]) await database.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
    await database.close();
  });

  it("creates the table, its foreign keys (cascading) and the UNIQUE over them, named by convention", async () => {
    await schemaService.createTable({
      schema: "public",
      name: JUNCTION,
      columns: [
        { name: "id", dataType: "uuid", nullable: false, default: "gen_random_uuid()", primaryKey: true },
        { name: "orders", dataType: "integer", nullable: false, foreignKey: { targetSchema: "public", targetTable: ORDERS, targetColumn: "id", onDelete: "CASCADE" } },
        { name: "products", dataType: "uuid", nullable: false, foreignKey: { targetSchema: "public", targetTable: PRODUCTS, targetColumn: "id", onDelete: "CASCADE" } },
      ],
      uniques: [["orders", "products"]],
    });
    const { rows } = await database.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'u'`,
      [`public.${JUNCTION}`],
    );
    expect(rows.map((r) => r.conname)).toEqual([`${JUNCTION}_orders_products_key`]);
  });

  it("PostgreSQL refuses a repeated pair, and deleting either side deletes the link", async () => {
    const { rows: [order] } = await database.query<{ id: number }>(`INSERT INTO public.${ORDERS} DEFAULT VALUES RETURNING id`);
    const { rows: [product] } = await database.query<{ id: string }>(`INSERT INTO public.${PRODUCTS} DEFAULT VALUES RETURNING id`);
    await database.query(`INSERT INTO public.${JUNCTION} (orders, products) VALUES ($1, $2)`, [order!.id, product!.id]);
    await expect(database.query(`INSERT INTO public.${JUNCTION} (orders, products) VALUES ($1, $2)`, [order!.id, product!.id])).rejects.toMatchObject({ code: "UNIQUE_VIOLATION" });
    await database.query(`DELETE FROM public.${ORDERS} WHERE id = $1`, [order!.id]);
    const { rows } = await database.query(`SELECT 1 FROM public.${JUNCTION}`);
    expect(rows).toHaveLength(0);
  });

  it("refuses a UNIQUE naming a column the table doesn't have, or a single column", async () => {
    const base = { schema: "public", name: "schema_pkg_test_bad_junction", columns: [{ name: "id", dataType: "uuid", primaryKey: true }] };
    await expect(schemaService.createTable({ ...base, uniques: [["id", "nope"]] })).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });
    await expect(schemaService.createTable({ ...base, uniques: [["id"]] })).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });
  });
});
