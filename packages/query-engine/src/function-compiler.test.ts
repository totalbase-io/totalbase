import { getFunctionDetail } from "@totalbase/pg-catalog";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFunctionCall } from "./function-compiler.js";

async function oidOf(database: Database, signature: string): Promise<number> {
  const { rows } = await database.query<{ oid: number }>(
    `SELECT $1::regprocedure::oid::int AS oid`,
    [signature],
  );
  return rows[0]!.oid;
}

describe("compileFunctionCall (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    const drops = [
      "public.fc_test_add(integer, integer)",
      "public.fc_test_range(integer, integer)",
      "public.fc_test_summary(uuid)",
      "public.fc_test_greet(text, text)",
      "public.fc_test_overload(integer)",
      "public.fc_test_overload(text)",
      "public.fc_test_bad_arg(integer)",
    ];
    for (const signature of drops) {
      await database.query(`DROP FUNCTION IF EXISTS ${signature}`);
    }

    await database.query(`
      CREATE FUNCTION public.fc_test_add(a integer, b integer)
      RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT a + b $$
    `);
    await database.query(`
      CREATE FUNCTION public.fc_test_range(start_value integer, count_value integer)
      RETURNS TABLE (n integer) LANGUAGE sql IMMUTABLE AS $$
        SELECT generate_series(start_value, start_value + count_value - 1)
      $$
    `);
    // Complex return shape: numeric, jsonb, timestamptz, text[] in one row.
    await database.query(`
      CREATE FUNCTION public.fc_test_summary(order_id uuid)
      RETURNS TABLE (total numeric, meta jsonb, seen_at timestamptz, tags text[])
      LANGUAGE sql IMMUTABLE AS $$
        SELECT 42.50::numeric, '{"ok": true}'::jsonb, now(), ARRAY['a', 'b']
      $$
    `);
    // DEFAULT parameter: greeting is optional.
    await database.query(`
      CREATE FUNCTION public.fc_test_greet(name text, greeting text DEFAULT 'Hello')
      RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT greeting || ', ' || name $$
    `);
    // Two real overloads, disambiguated by argument name.
    await database.query(`
      CREATE FUNCTION public.fc_test_overload(as_int integer)
      RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'int:' || as_int::text $$
    `);
    await database.query(`
      CREATE FUNCTION public.fc_test_overload(as_text text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'text:' || as_text $$
    `);
    // Used to exercise a PostgreSQL type-mismatch error at execution time.
    await database.query(`
      CREATE FUNCTION public.fc_test_bad_arg(n integer)
      RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT n $$
    `);
  });

  afterAll(async () => {
    const drops = [
      "public.fc_test_add(integer, integer)",
      "public.fc_test_range(integer, integer)",
      "public.fc_test_summary(uuid)",
      "public.fc_test_greet(text, text)",
      "public.fc_test_overload(integer)",
      "public.fc_test_overload(text)",
      "public.fc_test_bad_arg(integer)",
    ];
    for (const signature of drops) {
      await database.query(`DROP FUNCTION IF EXISTS ${signature}`);
    }
    await database.close();
  });

  it("introspects and calls a scalar function via named arguments", async () => {
    const oid = await oidOf(database, "public.fc_test_add(integer, integer)");
    const detail = await getFunctionDetail(database, oid);
    expect(detail.parameters.map((p) => p.name)).toEqual(["a", "b"]);
    expect(detail.returnsRows).toBe(false);

    const compiled = compileFunctionCall("public", "fc_test_add", detail, { a: 3, b: 4 });
    expect(compiled.scalar).toBe(true);
    const { rows: result } = await database.query<{ result: number }>(compiled.sql, compiled.params);
    expect(result[0]?.result).toBe(7);
  });

  it("introspects and calls a set-returning (table) function", async () => {
    const oid = await oidOf(database, "public.fc_test_range(integer, integer)");
    const detail = await getFunctionDetail(database, oid);
    expect(detail.returnsRows).toBe(true);

    const compiled = compileFunctionCall("public", "fc_test_range", detail, {
      start_value: 10,
      count_value: 3,
    });
    expect(compiled.scalar).toBe(false);
    const { rows: result } = await database.query<{ n: number }>(compiled.sql, compiled.params);
    expect(result.map((r) => r.n)).toEqual([10, 11, 12]);
  });

  it("rejects a call missing a required argument", async () => {
    const oid = await oidOf(database, "public.fc_test_add(integer, integer)");
    const detail = await getFunctionDetail(database, oid);
    expect(() => compileFunctionCall("public", "fc_test_add", detail, { a: 1 })).toThrow();
  });

  it("returns complex column types (numeric, jsonb, timestamptz, array) intact", async () => {
    const oid = await oidOf(database, "public.fc_test_summary(uuid)");
    const detail = await getFunctionDetail(database, oid);
    expect(detail.parameters).toEqual([{ name: "order_id", dataType: "uuid", hasDefault: false }]);
    expect(detail.returnsRows).toBe(true);

    const compiled = compileFunctionCall("public", "fc_test_summary", detail, {
      order_id: "00000000-0000-0000-0000-000000000000",
    });
    const { rows } = await database.query<{
      total: string;
      meta: { ok: boolean };
      seen_at: Date;
      tags: string[];
    }>(compiled.sql, compiled.params);

    expect(rows[0]?.total).toBe("42.50");
    expect(rows[0]?.meta).toEqual({ ok: true });
    expect(rows[0]?.seen_at).toBeInstanceOf(Date);
    expect(rows[0]?.tags).toEqual(["a", "b"]);
  });

  it("marks a trailing parameter with a DEFAULT as such and omits it when not given", async () => {
    const oid = await oidOf(database, "public.fc_test_greet(text, text)");
    const detail = await getFunctionDetail(database, oid);
    expect(detail.parameters).toEqual([
      { name: "name", dataType: "text", hasDefault: false },
      { name: "greeting", dataType: "text", hasDefault: true },
    ]);

    const compiled = compileFunctionCall("public", "fc_test_greet", detail, { name: "World" });
    expect(compiled.params).toEqual(["World"]);
    expect(compiled.sql).not.toContain("greeting");

    const { rows } = await database.query<{ result: string }>(compiled.sql, compiled.params);
    expect(rows[0]?.result).toBe("Hello, World");
  });

  it("still honors an explicitly-given value for a DEFAULT parameter", async () => {
    const oid = await oidOf(database, "public.fc_test_greet(text, text)");
    const detail = await getFunctionDetail(database, oid);

    const compiled = compileFunctionCall("public", "fc_test_greet", detail, {
      name: "World",
      greeting: "Hi",
    });
    const { rows } = await database.query<{ result: string }>(compiled.sql, compiled.params);
    expect(rows[0]?.result).toBe("Hi, World");
  });

  it("rejects a call whose argument has the wrong PostgreSQL type", async () => {
    const oid = await oidOf(database, "public.fc_test_bad_arg(integer)");
    const detail = await getFunctionDetail(database, oid);
    const compiled = compileFunctionCall("public", "fc_test_bad_arg", detail, { n: "not-a-number" });

    await expect(database.query(compiled.sql, compiled.params)).rejects.toBeInstanceOf(TotalBaseError);
  });

  it("resolves overloads by argument name and detects ambiguity", async () => {
    const intOid = await oidOf(database, "public.fc_test_overload(integer)");
    const textOid = await oidOf(database, "public.fc_test_overload(text)");
    const intDetail = await getFunctionDetail(database, intOid);
    const textDetail = await getFunctionDetail(database, textOid);

    expect(intDetail.parameters.map((p) => p.name)).toEqual(["as_int"]);
    expect(textDetail.parameters.map((p) => p.name)).toEqual(["as_text"]);

    // Simulates the route's overload matching: exactly one candidate's
    // parameter names match the given argument names.
    function matches(paramNames: string[], argNames: string[]): boolean {
      return paramNames.length === argNames.length && paramNames.every((n) => argNames.includes(n));
    }
    const argNames = ["as_int"];
    const candidates = [intDetail, textDetail].filter((d) => matches(d.parameters.map((p) => p.name), argNames));
    expect(candidates).toHaveLength(1);

    const compiled = compileFunctionCall("public", "fc_test_overload", intDetail, { as_int: 5 });
    const { rows } = await database.query<{ result: string }>(compiled.sql, compiled.params);
    expect(rows[0]?.result).toBe("int:5");
  });
});
