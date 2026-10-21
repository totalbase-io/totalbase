import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import type { PermissionDecision } from "@totalbase/permissions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FilterNode, QueryAST } from "./ast.js";
import { compileSelect } from "./compiler.js";
import { periodSql } from "./pg-dialect.js";
import { parseQuery } from "./parser.js";
import { SchemaContext } from "./schema-context.js";
import type { Period } from "./variables.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

const LIMITS = { maxFilterDepth: 10, maxRelationDepth: 3 };

function allowAll(): PermissionDecision {
  return "ALLOW";
}

describe("compileSelect (integration)", () => {
  let database: Database;
  let schemaContext: SchemaContext;
  let productsOid: number;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    // totalbase.search_normalize - what `search` compares through.
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });

    await database.query(`DROP TABLE IF EXISTS public.qe_test_products CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.qe_test_brands CASCADE`);
    await database.query(`
      CREATE TABLE public.qe_test_brands (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL
      )
    `);
    await database.query(`
      CREATE TABLE public.qe_test_products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        price numeric NOT NULL,
        active boolean NOT NULL DEFAULT true,
        brand uuid REFERENCES public.qe_test_brands (id),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows: brandRows } = await database.query<{ id: string }>(
      `INSERT INTO public.qe_test_brands (name) VALUES ('Acme'), ('Globex Pérez') RETURNING id`,
    );
    const [acme, globex] = brandRows;

    await database.query(
      `INSERT INTO public.qe_test_products (name, price, active, brand, updated_at) VALUES
       ('Widget', 50, true, $1, now()),
       ('Gadget', 150, true, $1, now()),
       ('Gizmo', 250, false, $2, now() - interval '48 hours')`,
      [acme!.id, globex!.id],
    );

    const { rows: oidRows } = await database.query<{ oid: number; brand_oid: number }>(
      `SELECT 'public.qe_test_products'::regclass::oid::int AS oid,
              'public.qe_test_brands'::regclass::oid::int AS brand_oid`,
    );
    productsOid = oidRows[0]!.oid;
    const brandsOid = oidRows[0]!.brand_oid;

    // The related table must be a registered, ACTIVE, exposed resource for relation traversal; the root one is
    // registered the same way, as every table the Data API reads is.
    for (const [oid, name] of [[brandsOid, "qe_test_brands"], [productsOid, "qe_test_products"]] as const) {
      await database.query(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES ($1, 'public', $2, 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}')
         ON CONFLICT (postgres_oid) DO UPDATE SET exposed_methods = '{GET,POST,PATCH,DELETE}', status = 'ACTIVE'`,
        [oid, name],
      );
    }

    schemaContext = new SchemaContext(database);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name IN ('qe_test_brands', 'qe_test_products')`);
    await database.query(`DROP TABLE IF EXISTS public.qe_test_products CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.qe_test_brands CASCADE`);
    await database.close();
  });

  async function compile(ast: QueryAST, overrides?: Partial<Parameters<typeof compileSelect>[0]>) {
    const root = await schemaContext.loadRoot("public", "qe_test_products", productsOid);
    return compileSelect({
      root,
      ast,
      schemaContext,
      fieldDecision: allowAll,
      rowFilter: undefined,
      resolveUserVariable: () => {
        throw new Error("no $USER context in this test");
      },
      defaultLimit: 50,
      maxLimit: 500,
      maxOffset: 100_000,
      ...overrides,
    });
  }

  it("selects explicit fields", async () => {
    const ast = parseQuery({ fields: "name,price" }, LIMITS);
    const compiled = await compile(ast);
    const { rows } = await database.query<{ name: string; price: string }>(compiled.sql, compiled.params);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name).sort()).toEqual(["Gadget", "Gizmo", "Widget"]);
  });

  it("projects all authorized columns when fields is omitted", async () => {
    const ast = parseQuery({}, LIMITS);
    const compiled = await compile(ast);
    const { rows } = await database.query<Record<string, unknown>>(compiled.sql, compiled.params);
    expect(rows[0]).toHaveProperty("name");
    expect(rows[0]).toHaveProperty("price");
    expect(rows[0]).toHaveProperty("brand");
  });

  it("filters with a comparison operator, coercing numeric literals", async () => {
    const ast = parseQuery({ where: { price: { _gt: "100" } } }, LIMITS);
    const compiled = await compile(ast);
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows.map((r) => r.name).sort()).toEqual(["Gadget", "Gizmo"]);
  });

  it("filters with boolean coercion", async () => {
    const ast = parseQuery({ where: { active: { _eq: "false" } } }, LIMITS);
    const compiled = await compile(ast);
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows.map((r) => r.name)).toEqual(["Gizmo"]);
  });

  it("traverses a relation in fields and where", async () => {
    const ast = parseQuery(
      { fields: "name,brand.name", where: { "brand.name": { _eq: "Acme" } } },
      LIMITS,
    );
    const compiled = await compile(ast);
    const { rows } = await database.query<{ name: string; "brand.name": string }>(
      compiled.sql,
      compiled.params,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["Gadget", "Widget"]);
    expect(rows.every((r) => r["brand.name"] === "Acme")).toBe(true);
  });

  it("compiles $INTERVAL.* against a timestamptz column", async () => {
    const ast = parseQuery({ where: { updated_at: { _lt: "$INTERVAL.24h" } } }, LIMITS);
    const compiled = await compile(ast);
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows.map((r) => r.name)).toEqual(["Gizmo"]);
  });

  it("compiles $PERIOD.* bounds PostgreSQL computes, with nothing from the request in the SQL", async () => {
    const ast = parseQuery({ where: { updated_at: { _gte: "$PERIOD.today.from", _lt: "$PERIOD.today.to" } } }, LIMITS);
    const compiled = await compile(ast);
    expect(compiled.sql).toContain("date_trunc('day', CURRENT_TIMESTAMP)");
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    // Gizmo was updated 48 hours ago - never today.
    expect(rows.map((r) => r.name).sort()).toEqual(["Gadget", "Widget"]);

    const between = await compile(parseQuery({ where: { updated_at: { _between: "$PERIOD.this_year.from,$PERIOD.this_year.to" } } }, LIMITS));
    expect((await database.query(between.sql, between.params)).rows.length).toBeGreaterThanOrEqual(2);
  });

  it("gives every $PERIOD.* a range [from, to) around its own time, and each last_* ends where its this_* starts", async () => {
    const units = ["day", "week", "month", "quarter", "year"] as const;
    const pairs: Record<(typeof units)[number], [Period, Period]> = {
      day: ["today", "yesterday"],
      week: ["this_week", "last_week"],
      month: ["this_month", "last_month"],
      quarter: ["this_quarter", "last_quarter"],
      year: ["this_year", "last_year"],
    };
    for (const unit of units) {
      const [current, previous] = pairs[unit];
      const { rows } = await database.query<{ ok_current: boolean; ok_previous: boolean; contiguous: boolean; truncated: boolean }>(
        `SELECT ${periodSql(current, "from")} <= now() AND now() < ${periodSql(current, "to")} AS ok_current,
                ${periodSql(previous, "from")} < ${periodSql(previous, "to")} AS ok_previous,
                ${periodSql(previous, "to")} = ${periodSql(current, "from")} AS contiguous,
                ${periodSql(current, "from")} = date_trunc('${unit}', now()) AS truncated`,
      );
      expect(rows[0], unit).toEqual({ ok_current: true, ok_previous: true, contiguous: true, truncated: true });
    }
  });

  it("resolves $USER.* from the injected resolver", async () => {
    const ast = parseQuery({ where: { name: { _eq: "$USER.favorite_product" } } }, LIMITS);
    const compiled = await compile(ast, { resolveUserVariable: () => "Gadget" });
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows.map((r) => r.name)).toEqual(["Gadget"]);
  });

  it("combines the request where and the permission row filter with AND", async () => {
    const ast = parseQuery({ where: { price: { _gt: "0" } } }, LIMITS);
    const compiled = await compile(ast, {
      rowFilter: { type: "comparison", path: ["active"], operator: "_eq", value: "true" },
    });
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows.map((r) => r.name).sort()).toEqual(["Gadget", "Widget"]);
  });

  it("a row filter on a relation path needs no field grant, only never a DENY (B45, Security.md §6.5)", async () => {
    const ast = parseQuery({ fields: "name" }, LIMITS);
    const rowFilter: FilterNode = { type: "comparison", path: ["brand", "name"], operator: "_eq", value: "Acme" };
    const onlyName = (path: string): PermissionDecision => (path === "name" ? "ALLOW" : "UNDEFINED");
    const compiled = await compile(ast, { rowFilter, fieldDecision: onlyName });
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows.length).toBeGreaterThan(0);
    // The request's own filter on the same path still needs it.
    await expect(compile(parseQuery({ fields: "name", where: { "brand.name": { _eq: "Acme" } } }, LIMITS), { fieldDecision: onlyName }))
      .rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
    // A DENY (a protected column, a denied field) stays out of the row filter too.
    const deniedBrand = (path: string): PermissionDecision => (path === "brand.name" ? "DENY" : "ALLOW");
    await expect(compile(ast, { rowFilter, fieldDecision: deniedBrand })).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
  });

  it("orders by the key without a field grant on it - the default order is the server's - but never by a denied column", async () => {
    const ast = parseQuery({ fields: "name" }, LIMITS);
    const onlyName = (path: string): PermissionDecision => (path === "name" ? "ALLOW" : "UNDEFINED");
    expect((await compile(ast, { fieldDecision: onlyName })).sql).toContain(`ORDER BY t0."id" ASC`);
    const deniedKey = (path: string): PermissionDecision => (path === "id" ? "DENY" : "ALLOW");
    expect((await compile(ast, { fieldDecision: deniedKey })).sql).not.toContain("ORDER BY");
    // A request's own order_by still needs the field.
    await expect(compile(parseQuery({ fields: "name", order_by: "id" }, LIMITS), { fieldDecision: onlyName })).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
  });

  it("search: a number also finds a numeric field of the projection holding exactly it (Data_API.md §3.5)", async () => {
    const run = async (query: Record<string, unknown>) => {
      const compiled = await compile(parseQuery(query, LIMITS));
      return (await database.query<{ name: string }>(compiled.sql, compiled.params)).rows.map((r) => r.name);
    };
    expect(await run({ fields: "name,price", search: "150" })).toEqual(["Gadget"]);
    // Without fields, every root column is a candidate; never by a part of the number, nor in a field not read.
    expect(await run({ search: "150" })).toEqual(["Gadget"]);
    expect(await run({ fields: "name,price", search: "15" })).toEqual([]);
    expect(await run({ fields: "name", search: "150" })).toEqual([]);
  });

  it("search: every word is a term, each found in some field; case and accents don't matter (Data_API.md §3.5)", async () => {
    const run = async (query: Record<string, unknown>) => {
      const compiled = await compile(parseQuery(query, LIMITS));
      return (await database.query<{ name: string }>(compiled.sql, compiled.params)).rows.map((r) => r.name).sort();
    };
    // "gizmo perez": Gizmo in name AND perez in brand.name - accents and case aside.
    expect(await run({ fields: "name,brand.name", search: "gizmo PEREZ" })).toEqual(["Gizmo"]);
    expect(await run({ fields: "name,brand.name", search: "pérez" })).toEqual(["Gizmo"]);
    // Both terms must be found - in any field each.
    expect(await run({ fields: "name,brand.name", search: "gizmo acme" })).toEqual([]);
    expect(await run({ fields: "name,brand.name", search: "  acme   g " })).toEqual(["Gadget", "Widget"]);
    // A term's own wildcards are literal.
    expect(await run({ fields: "name", search: "G_dget" })).toEqual([]);
    expect(await run({ fields: "name", search: "%" })).toEqual([]);
    // Only spaces: no search at all.
    expect(await run({ fields: "name", search: "   " })).toEqual(["Gadget", "Gizmo", "Widget"]);
  });

  it("search: a whole UUID finds a uuid field of the projection holding exactly it - a row by its id (Data_API.md §3.5)", async () => {
    const { rows: [gadget] } = await database.query<{ id: string }>(`SELECT id FROM public.qe_test_products WHERE name = 'Gadget'`);
    const run = async (query: Record<string, unknown>) => {
      const compiled = await compile(parseQuery(query, LIMITS));
      return (await database.query<{ name: string }>(compiled.sql, compiled.params)).rows.map((r) => r.name);
    };
    expect(await run({ fields: "id,name", search: gadget!.id.toUpperCase() })).toEqual(["Gadget"]);
    // Not by a part of it, nor without the field read.
    expect(await run({ fields: "id,name", search: gadget!.id.slice(0, 8) })).toEqual([]);
    expect(await run({ fields: "name", search: gadget!.id })).toEqual([]);
  });

  it("search_fields names exactly the fields searched - read or not, never a silent widening (Data_API.md §3.5)", async () => {
    const run = async (query: Record<string, unknown>) => {
      const compiled = await compile(parseQuery(query, LIMITS));
      return (await database.query<{ name: string }>(compiled.sql, compiled.params)).rows.map((r) => r.name).sort();
    };
    expect(await run({ fields: "name,brand.name", search: "acme" })).toEqual(["Gadget", "Widget"]);
    expect(await run({ fields: "name,brand.name", search: "acme", search_fields: "name" })).toEqual([]);
    // Not among the fields read: searched all the same, the rows come back with `fields` only.
    expect(await run({ fields: "name", search: "acme", search_fields: "brand.name" })).toEqual(["Gadget", "Widget"]);
    expect(await run({ search: "150", search_fields: "price" })).toEqual(["Gadget"]);
    // A field that doesn't exist is the request's error.
    await expect(run({ fields: "name", search: "acme", search_fields: "nope" })).rejects.toMatchObject({ code: "INVALID_FIELD" });
  });

  it("search: a day (ISO) finds a date or timestamp field on that whole day, a time HH:mm that minute (Data_API.md §3.5)", async () => {
    const { rows: [day] } = await database.query<{ today: string; before: string }>(
      `SELECT to_char(now(), 'YYYY-MM-DD') AS today, to_char(now() - interval '48 hours', 'YYYY-MM-DD') AS before`,
    );
    const run = async (query: Record<string, unknown>) => {
      const compiled = await compile(parseQuery(query, LIMITS));
      return (await database.query<{ name: string }>(compiled.sql, compiled.params)).rows.map((r) => r.name).sort();
    };
    expect(await run({ fields: "name,updated_at", search: day!.today })).toEqual(["Gadget", "Widget"]);
    expect(await run({ fields: "name,updated_at", search: day!.before })).toEqual(["Gizmo"]);
    // Only a whole, real day: a month, a year or an impossible date is just text, found nowhere here.
    expect(await run({ fields: "name,updated_at", search: day!.today.slice(0, 7) })).toEqual([]);
    expect(await run({ fields: "name,updated_at", search: "2026-02-30" })).toEqual([]);
    // A time term reaches no timestamp - nor errs.
    expect(await run({ fields: "name,updated_at", search: "10:30" })).toEqual([]);
  });

  it("search with nothing to search in matches no row - never the whole table (Data_API.md §3.5)", async () => {
    const compiled = await compile(parseQuery({ fields: "id", search: "Widg" }, LIMITS));
    expect((await database.query(compiled.sql, compiled.params)).rows).toEqual([]);
  });

  it("search matches authorized textual root fields", async () => {
    const ast = parseQuery({ search: "Widg" }, LIMITS);
    const compiled = await compile(ast);
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows.map((r) => r.name)).toEqual(["Widget"]);
  });

  it("group_by + aggregate + having", async () => {
    const ast = parseQuery(
      { group_by: "brand", _sum: { price: "total" }, having: { total: { _gt: "100" } } },
      LIMITS,
    );
    const compiled = await compile(ast);
    const { rows } = await database.query<{ total: string }>(compiled.sql, compiled.params);
    // Acme: 50+150=200 (>100, included). Globex: 250 (>100, included). Both groups qualify.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Number(r.total) > 100)).toBe(true);
  });

  it("orders by an aggregate alias", async () => {
    const ast = parseQuery(
      { group_by: "brand", _sum: { price: "total" }, order_by: "-total" },
      LIMITS,
    );
    const compiled = await compile(ast);
    const { rows } = await database.query<{ total: string }>(compiled.sql, compiled.params);
    const totals = rows.map((r) => Number(r.total));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it("applies limit/offset and produces a matching count query", async () => {
    const ast = parseQuery({ limit: "1", offset: "1", order_by: "price", count: "true" }, LIMITS);
    const compiled = await compile(ast);
    const { rows } = await database.query<{ name: string }>(compiled.sql, compiled.params);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Gadget"); // sorted by price: Widget(50), Gadget(150), Gizmo(250)

    expect(compiled.countSql).toBeDefined();
    const { rows: countRows } = await database.query<{ count: string }>(
      compiled.countSql!,
      compiled.countParams,
    );
    expect(Number(countRows[0]?.count)).toBe(3);
  });

  it("rejects a field the caller is not authorized to read", async () => {
    const ast = parseQuery({ fields: "name,price" }, LIMITS);
    await expect(
      compile(ast, {
        fieldDecision: (path) => (path === "price" ? "DENY" : "ALLOW"),
      }),
    ).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
  });

  it("rejects an unknown field with INVALID_FIELD", async () => {
    const ast = parseQuery({ fields: "does_not_exist" }, LIMITS);
    await expect(compile(ast)).rejects.toMatchObject({ code: "INVALID_FIELD" });
  });

  it("rejects traversal into a non-exposed relation", async () => {
    await database.query(
      `UPDATE totalbase.resources SET exposed_methods = '{}' WHERE "schema" = 'public' AND name = 'qe_test_brands'`,
    );
    // A fresh SchemaContext is required: schemaContext caches resolved
    // relations across tests, which would otherwise mask this check.
    const freshContext = new SchemaContext(database);
    try {
      const root = await freshContext.loadRoot("public", "qe_test_products", productsOid);
      const ast = parseQuery({ fields: "brand.name" }, LIMITS);
      await expect(
        compileSelect({
          root,
          ast,
          schemaContext: freshContext,
          fieldDecision: allowAll,
          rowFilter: undefined,
          resolveUserVariable: () => undefined,
          defaultLimit: 50,
          maxLimit: 500,
          maxOffset: 100_000,
        }),
      ).rejects.toMatchObject({ code: "INVALID_RELATION" });
    } finally {
      await database.query(
        `UPDATE totalbase.resources SET exposed_methods = '{GET,POST,PATCH,DELETE}' WHERE "schema" = 'public' AND name = 'qe_test_brands'`,
      );
    }
  });
});
