import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardsAdminService } from "./dashboards-admin-service.js";
import { exactNumber } from "./typed-result.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "dashboards_typed_test_sales";
const VIEW = "dashboards_typed_test_sales_v";
const LIMITS = { timeoutMs: 5_000, maxRows: 100 };
const NO_VARS = { userId: null, variables: [], values: {} };

describe("exactNumber", () => {
  it("is the number when a double holds it exactly - up to 15 significant digits - else null", () => {
    expect(exactNumber("82.70")).toBe(82.7);
    expect(exactNumber("-0.0001")).toBe(-0.0001);
    expect(exactNumber("123456789012345")).toBe(123456789012345);
    expect(exactNumber("1234567890123456")).toBeNull();
    expect(exactNumber("12345678901234567890")).toBeNull();
    expect(exactNumber("0.1234567890123456")).toBeNull();
    expect(exactNumber("NaN")).toBeNull();
    expect(exactNumber("Infinity")).toBeNull();
  });
});

/**
 * A widget's result, typed (Specification_Dashboards.md §2.3, D1): each column's origin when PostgreSQL reports one -
 * a column as is, aliased, through a subquery or from a view - its presentation, and numeric/bigint as numbers.
 */
describe("a widget's typed result (integration)", () => {
  let database: Database;
  let dashboards: DashboardsAdminService;
  let tableId: string;
  let viewId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dashboards = new DashboardsAdminService(database);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, mes date NOT NULL, total numeric(12,2) NOT NULL, unidades bigint NOT NULL)`);
    await database.query(`INSERT INTO public.${TABLE} (mes, total, unidades) VALUES ('2026-01-01', 1234.50, 7), ('2026-02-01', 82.70, 9007199254740993)`);
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT mes, total FROM public.${TABLE}`);
    const register = async (name: string, type: string) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status) VALUES ($1::regclass::oid, 'public', $2, $3, 'ACTIVE') RETURNING id`,
      [`public.${name}`, name, type],
    )).rows[0]!.id;
    tableId = await register(TABLE, "TABLE");
    viewId = await register(VIEW, "VIEW");
    await database.query(
      `INSERT INTO totalbase.resources_columns (resource, attnum, name, config)
       SELECT $1, attnum, attname, '{"label": "Facturado", "displayFormat": "#,##0.00"}'::jsonb FROM pg_attribute
       WHERE attrelid = $2::regclass AND attname = 'total'`,
      [tableId, `public.${TABLE}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [[tableId, viewId]]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.close();
  });

  it("names each column's origin and presentation - aliased too - and none for an expression", async () => {
    const result = await dashboards.executeQuery(`SELECT mes, total AS facturado, sum(total) OVER () AS acumulado, unidades FROM public.${TABLE} ORDER BY mes`, LIMITS, NO_VARS);
    const [mes, facturado, acumulado, unidades] = result.columns;
    expect(mes).toMatchObject({ name: "mes", dataType: "date", origin: { schema: "public", table: TABLE, column: "mes", resourceId: tableId } });
    expect(mes!.presentation).toBeUndefined();
    expect(facturado).toMatchObject({ name: "facturado", dataType: "numeric", origin: { column: "total" }, presentation: { label: "Facturado", displayFormat: "#,##0.00" } });
    expect(acumulado!.origin).toBeUndefined();
    // numeric and bigint as numbers where exact; a bigint past 2^53 stays its exact text, the column marked.
    expect(result.rows.map((r) => [r.facturado, r.acumulado, r.unidades])).toEqual([[1234.5, 1317.2, 7], [82.7, 1317.2, "9007199254740993"]]);
    expect(unidades!.lossy).toBe(true);
    expect(facturado!.lossy).toBeUndefined();
  });

  it("reads a view's column as the view's, with the presentation it inherits from its table", async () => {
    const result = await dashboards.executeQuery(`SELECT total FROM public.${VIEW}`, LIMITS, NO_VARS);
    expect(result.columns[0]).toMatchObject({ origin: { table: VIEW, column: "total", resourceId: viewId }, presentation: { label: "Facturado" } });
  });
});
