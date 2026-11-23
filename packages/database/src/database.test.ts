import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TotalBaseError } from "@totalbase/errors";
import type { Principal } from "@totalbase/shared";
import { Database, parameterText } from "./database.js";
import { loadDatabaseConfigFromEnv } from "./config.js";

const TABLE = "database_pkg_test_scratch";

describe("Database (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.ping();
    await database.query(`
      CREATE TABLE IF NOT EXISTS public."${TABLE}" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL UNIQUE,
        amount integer
      )
    `);
    await database.query(`ALTER TABLE public."${TABLE}" DROP CONSTRAINT IF EXISTS database_pkg_test_amount_positive`);
    await database.query(`ALTER TABLE public."${TABLE}" ADD CONSTRAINT database_pkg_test_amount_positive CHECK (amount > 0)`);
    await database.query(`COMMENT ON CONSTRAINT database_pkg_test_amount_positive ON public."${TABLE}" IS 'Amount must be greater than zero'`);
    await database.query(`ALTER TABLE public."${TABLE}" DROP CONSTRAINT IF EXISTS database_pkg_test_code_len`);
    await database.query(`ALTER TABLE public."${TABLE}" ADD CONSTRAINT database_pkg_test_code_len CHECK (length(code) <= 10)`);
  });

  beforeEach(async () => {
    await database.query(`TRUNCATE public."${TABLE}"`);
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public."${TABLE}"`);
    await database.close();
  });

  // quoteLiteral writes a backslash as itself: every connection must read strings so, whatever the role's default.
  it("pins standard_conforming_strings on every connection", async () => {
    expect((await database.query<{ on: string }>("SELECT current_setting('standard_conforming_strings') AS on")).rows[0]!.on).toBe("on");
  });

  it("readOnlyTransaction() refuses writes, and leaves nothing on its pooled connection - not even a session setting", async () => {
    // One connection: the next query is served by the very connection the transaction used.
    const single = new Database({ ...loadDatabaseConfigFromEnv(), poolMax: 1 });
    try {
      const before = (await single.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz")).rows[0]!.tz;
      const other = before === "Pacific/Kiritimati" ? "UTC" : "Pacific/Kiritimati";
      await single.readOnlyTransaction(async (client) => {
        await client.query("SELECT set_config('TimeZone', $1, false)", [other]);
        expect((await client.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz")).rows[0]!.tz).toBe(other);
      });
      expect((await single.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz")).rows[0]!.tz).toBe(before);

      await expect(single.readOnlyTransaction((client) => client.query(`INSERT INTO public."${TABLE}" (code) VALUES ('ro')`))).rejects.toBeInstanceOf(TotalBaseError);
      expect((await single.query(`SELECT 1 FROM public."${TABLE}" WHERE code = 'ro'`)).rowCount).toBe(0);

      // Security regression (Dashboards.md §2.3): a session advisory lock survives ROLLBACK - taken by a widget's SQL,
      // it stayed on the pooled connection, holding TotalBase's own locks until the connection closed.
      const held = `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
      await single.readOnlyTransaction((client) => client.query("SELECT pg_advisory_lock(424242)"));
      expect((await single.query<{ n: number }>(held)).rows[0]!.n).toBe(0);
    } finally {
      await single.close();
    }
  });

  it("parameterText() writes a value as PostgreSQL reads it back from text - each cast, in one text[]", async () => {
    const values = [null, 41, "a,b", ["x", "y,z", null], { k: 1 }, Buffer.from("hi"), new Date("2026-01-02T03:04:05Z")];
    const { rows } = await database.query<Record<string, unknown>>(
      `SELECT $1::text[] IS NOT NULL AS ok, ($1::text[])[1] IS NULL AS a, ($1::text[])[2]::int + 1 AS b, ($1::text[])[3] AS c, ($1::text[])[4]::text[] AS d,
              ($1::text[])[5]::jsonb ->> 'k' AS e, convert_from(($1::text[])[6]::bytea, 'UTF8') AS f, ($1::text[])[7]::timestamptz = '2026-01-02T03:04:05Z' AS g`,
      [values.map(parameterText)],
    );
    expect(rows[0]).toEqual({ ok: true, a: true, b: 42, c: "a,b", d: ["x", "y,z", null], e: "1", f: "hi", g: true });
  });

  // The widget query role's column list (Dashboards.md §2.10) comes from a description: it must run nothing.
  it("readOnlyTransaction()'s describe() gives the columns, origins and typmods without running the statement", async () => {
    await database.readOnlyTransaction(async (client) => {
      const fields = await client.describe(`SELECT set_config('totalbase.describe_probe', 'ran', true) AS ran, code, 1.5::numeric(5,2) AS n, $1[1]::int AS p FROM public."${TABLE}"`, [1009]);
      expect(fields.map(({ name, dataTypeModifier }) => [name, dataTypeModifier])).toEqual([["ran", -1], ["code", -1], ["n", (5 << 16) + 2 + 4], ["p", -1]]);
      expect(fields[1]!.tableId).toBeGreaterThan(0);
      expect((await client.query<{ v: string | null }>("SELECT current_setting('totalbase.describe_probe', true) AS v")).rows[0]!.v).toBeFalsy();
    });
    await expect(database.readOnlyTransaction((client) => client.describe("SELECT FROM nowhere_at_all"))).rejects.toMatchObject({ code: "UNDEFINED_TABLE" });
    // A refusal leaves the connection usable, its transaction rolled back.
    await expect(database.query<{ n: number }>("SELECT 1 AS n")).resolves.toMatchObject({ rows: [{ n: 1 }] });
  });

  // Security regression (Foundations.md §19, Administration.md §5): raw SQL's session state stayed on its pooled
  // connection - `SET standard_conforming_strings = off` turned the quoting TotalBase relies on into an injection
  // for the next request, and a BEGIN left open, a lock, a LISTEN or a temporary table outlived the statement.
  it("queryRaw() and transactionRaw() leave nothing on their pooled connection", async () => {
    const single = new Database({ ...loadDatabaseConfigFromEnv(), poolMax: 1 });
    const state = () =>
      single.query<{ scs: string; tx: boolean; locks: number; listens: number; temps: number; role: boolean; prepared: number }>(
        `SELECT current_setting('standard_conforming_strings') AS scs, to_regclass('public.raw_left_open') IS NOT NULL AS tx,
                current_user = session_user AS role, (SELECT count(*)::int FROM pg_prepared_statements) AS prepared,
                (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS locks,
                (SELECT count(*)::int FROM pg_listening_channels()) AS listens,
                (SELECT count(*)::int FROM pg_class WHERE relpersistence = 't' AND pg_table_is_visible(oid)) AS temps`,
      );
    try {
      await single.queryRaw("SET standard_conforming_strings = off; SELECT pg_advisory_lock(434343); LISTEN raw_left; CREATE TEMP TABLE raw_left (x int); BEGIN; CREATE TABLE public.raw_left_open (x int)");
      expect((await state()).rows[0]).toEqual({ scs: "on", tx: false, locks: 0, listens: 0, temps: 0, role: true, prepared: 0 });
      // SEC-85: RESET ALL leaves a SET ROLE in place - later requests on the connection ran as that role.
      await single.query(`DROP ROLE IF EXISTS raw_left_role`);
      await single.query(`CREATE ROLE raw_left_role`);
      try {
        await single.query(`GRANT raw_left_role TO CURRENT_USER`);
        await single.queryRaw("SET ROLE raw_left_role; PREPARE raw_left_stmt AS SELECT 1");
        expect((await state()).rows[0]).toMatchObject({ role: true, prepared: 0 });
      } finally {
        await single.query(`DROP ROLE IF EXISTS raw_left_role`);
      }
      await single.transactionRaw((client) => client.queryRaw("SET SESSION standard_conforming_strings = off"));
      expect((await state()).rows[0]!.scs).toBe("on");
    } finally {
      await single.close();
    }
  });

  it("returns a date column as its own YYYY-MM-DD text, whatever the session/server timezone", async () => {
    // Regression: node-postgres' default parsed `date` into a JS Date at
    // local midnight, which serialized as a timezone-shifted instant.
    await database.transaction(async (client) => {
      await client.query("SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'");
      const { rows } = await client.query<{ d: unknown, missing: unknown }>("SELECT '1985-11-03'::date AS d, NULL::date AS missing");
      expect(rows[0]).toEqual({ d: "1985-11-03", missing: null });
    });
    const { rows } = await database.query<{ d: unknown }>("SELECT '2026-01-31'::date AS d");
    expect(rows[0]!.d).toBe("2026-01-31");
  });

  it("returns an interval as PostgreSQL's own text, and an interval[] as an array of them", async () => {
    // Regression: node-postgres' default parsed it into an object ({ days, hours }) a form showed as [object Object].
    const { rows } = await database.query<{ i: unknown, a: unknown, missing: unknown }>(
      "SELECT '1 day 2 hours 3 minutes'::interval AS i, ARRAY['1 day'::interval, '00:30'::interval] AS a, NULL::interval AS missing",
    );
    expect(rows[0]).toEqual({ i: "1 day 02:03:00", a: ["1 day", "00:30:00"], missing: null });
  });

  it("commits a successful transaction", async () => {
    await database.transaction(async (client) => {
      await client.query(`INSERT INTO public."${TABLE}" (code) VALUES ($1)`, ["a"]);
    });

    const { rows } = await database.query<{ code: string }>(
      `SELECT code FROM public."${TABLE}"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe("a");
  });

  it("rolls back the transaction when the callback throws", async () => {
    await expect(
      database.transaction(async (client) => {
        await client.query(`INSERT INTO public."${TABLE}" (code) VALUES ($1)`, ["b"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const { rows } = await database.query(`SELECT code FROM public."${TABLE}"`);
    expect(rows).toHaveLength(0);
  });

  it("maps a unique_violation to a TotalBaseError with UNIQUE_VIOLATION", async () => {
    await database.query(`INSERT INTO public."${TABLE}" (code) VALUES ($1)`, ["dup"]);

    const error = await database
      .query(`INSERT INTO public."${TABLE}" (code) VALUES ($1)`, ["dup"])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TotalBaseError);
    expect((error as TotalBaseError).code).toBe("UNIQUE_VIOLATION");
    expect((error as TotalBaseError).httpStatus).toBe(409);
    expect((error as TotalBaseError).source).toBe("POSTGRESQL");
  });

  it("maps a check_violation to the constraint's own COMMENT ('Error Message') when it has one", async () => {
    const error = await database
      .query(`INSERT INTO public."${TABLE}" (code, amount) VALUES ($1, $2)`, ["neg", -5])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TotalBaseError);
    expect((error as TotalBaseError).code).toBe("CHECK_VIOLATION");
    expect((error as TotalBaseError).message).toBe("Amount must be greater than zero");
  });

  it("falls back to PostgreSQL's own message for a check_violation with no COMMENT set", async () => {
    const error = await database
      .query(`INSERT INTO public."${TABLE}" (code) VALUES ($1)`, ["this-code-is-way-too-long"])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TotalBaseError);
    expect((error as TotalBaseError).code).toBe("CHECK_VIOLATION");
    expect((error as TotalBaseError).message).toContain("database_pkg_test_code_len");
  });

  it("still maps a check_violation raised mid-transaction, after rollback", async () => {
    const error = await database
      .transaction(async (client) => {
        await client.query(`INSERT INTO public."${TABLE}" (code, amount) VALUES ($1, $2)`, ["also-neg", -1]);
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TotalBaseError);
    expect((error as TotalBaseError).code).toBe("CHECK_VIOLATION");
    expect((error as TotalBaseError).message).toBe("Amount must be greater than zero");

    const { rows } = await database.query(`SELECT code FROM public."${TABLE}" WHERE code = 'also-neg'`);
    expect(rows).toHaveLength(0); // rolled back, not left half-written
  });

  it("names the column a violation is about - a NOT NULL, a one-column UNIQUE or CHECK - never one of several", async () => {
    const fieldOf = (sql: string, params: unknown[]) => database.query(sql, params).catch((e: unknown) => (e as TotalBaseError).field);
    expect(await fieldOf(`INSERT INTO public."${TABLE}" (amount) VALUES ($1)`, [1])).toBe("code");
    await database.query(`INSERT INTO public."${TABLE}" (code) VALUES ($1)`, ["dup"]);
    expect(await fieldOf(`INSERT INTO public."${TABLE}" (code) VALUES ($1)`, ["dup"])).toBe("code");
    // Its COMMENT is the message, its column the field.
    const error = (await database.query(`INSERT INTO public."${TABLE}" (code, amount) VALUES ($1, $2)`, ["neg", -5]).catch((e: unknown) => e)) as TotalBaseError;
    expect(error).toMatchObject({ message: "Amount must be greater than zero", field: "amount" });
    expect(error.toPublicJSON()).toMatchObject({ code: "CHECK_VIOLATION", field: "amount" });
    await database.query(`ALTER TABLE public."${TABLE}" ADD CONSTRAINT database_pkg_test_two_columns CHECK (amount IS NULL OR length(code) < amount)`);
    try {
      expect(await fieldOf(`INSERT INTO public."${TABLE}" (code, amount) VALUES ($1, $2)`, ["abcdef", 2])).toBeUndefined();
    } finally {
      await database.query(`ALTER TABLE public."${TABLE}" DROP CONSTRAINT database_pkg_test_two_columns`);
    }
  });

  // A domain's CHECK carried no message: the lookup joined the constraint to a table, and a domain's has none.
  it("reads a domain CHECK violation as the domain constraint's COMMENT", async () => {
    const DOMAIN = "database_pkg_test_code";
    const HOLDER = `${TABLE}_domain`;
    await database.query(`DROP TABLE IF EXISTS public."${HOLDER}"`);
    await database.query(`DROP DOMAIN IF EXISTS public."${DOMAIN}"`);
    await database.query(`CREATE DOMAIN public."${DOMAIN}" AS text CONSTRAINT database_pkg_test_code_format CHECK (VALUE ~ '^[0-9]{2}-[0-9]{8}-[0-9]$')`);
    try {
      await database.query(`COMMENT ON CONSTRAINT database_pkg_test_code_format ON DOMAIN public."${DOMAIN}" IS 'The CUIT goes with hyphens: 30-12345678-9'`);
      await database.query(`CREATE TABLE public."${HOLDER}" (id serial PRIMARY KEY, cuit public."${DOMAIN}")`);
      const error = (await database.query(`INSERT INTO public."${HOLDER}" (cuit) VALUES ($1)`, ["30123456789"]).catch((e: unknown) => e)) as TotalBaseError;
      expect(error).toMatchObject({ code: "CHECK_VIOLATION", message: "The CUIT goes with hyphens: 30-12345678-9" });
    } finally {
      await database.query(`DROP TABLE IF EXISTS public."${HOLDER}"`);
      await database.query(`DROP DOMAIN IF EXISTS public."${DOMAIN}"`);
    }
  });

  it("reads a foreign key violation as its constraint's COMMENT, with no field - the column is the other table's", async () => {
    const CHILD = `${TABLE}_child`;
    await database.query(`CREATE TABLE public."${CHILD}" (id serial PRIMARY KEY, parent uuid CONSTRAINT database_pkg_test_child_parent REFERENCES public."${TABLE}" (id))`);
    try {
      await database.query(`COMMENT ON CONSTRAINT database_pkg_test_child_parent ON public."${CHILD}" IS 'It still has children'`);
      const { rows } = await database.query<{ id: string }>(`INSERT INTO public."${TABLE}" (code) VALUES ('parent') RETURNING id`);
      await database.query(`INSERT INTO public."${CHILD}" (parent) VALUES ($1)`, [rows[0]!.id]);
      const error = (await database.query(`DELETE FROM public."${TABLE}" WHERE id = $1`, [rows[0]!.id]).catch((e: unknown) => e)) as TotalBaseError;
      expect(error).toMatchObject({ code: "FOREIGN_KEY_VIOLATION", message: "It still has children", field: undefined });
    } finally {
      await database.query(`DROP TABLE public."${CHILD}"`);
    }
  });

  it("applies principal/request context as SET LOCAL GUCs, visible only inside the transaction", async () => {
    const principal: Principal = { type: "ADMIN", id: randomUUID() };
    const requestId = randomUUID();

    const seen = await database.transaction(async (client) => {
      const { rows } = await client.query<{ user_id: string; request_id: string; principal_type: string }>(
        `SELECT
           current_setting('totalbase.user_id', true) AS user_id,
           current_setting('totalbase.request_id', true) AS request_id,
           current_setting('totalbase.principal_type', true) AS principal_type`,
      );
      return rows[0];
    }, { principal, requestId });

    expect(seen?.user_id).toBe(principal.id);
    expect(seen?.request_id).toBe(requestId);
    expect(seen?.principal_type).toBe("ADMIN");

    // SET LOCAL only lives for the transaction; outside of it, unset.
    const { rows: after } = await database.query<{ request_id: string }>(
      `SELECT current_setting('totalbase.request_id', true) AS request_id`,
    );
    expect(after[0]?.request_id).toBe("");
  });

  it("query(), transaction() and readOnlyTransaction() reject stacked statements, even with no parameters (security regression)", async () => {
    await database.query(`INSERT INTO public."${TABLE}" (code, amount) VALUES ('stacked', 1)`);
    const stacked = `SELECT 1; DELETE FROM public."${TABLE}"`;
    await expect(database.query(stacked)).rejects.toBeDefined();
    await expect(database.transaction((client) => client.query(stacked))).rejects.toBeDefined();
    await expect(database.readOnlyTransaction((client) => client.query(stacked))).rejects.toBeDefined();
    const { rows } = await database.query(`SELECT code FROM public."${TABLE}" WHERE code = 'stacked'`);
    expect(rows).toHaveLength(1);
  });

  it("queryRaw executes a multi-statement script and returns the last statement's result", async () => {
    const result = await database.queryRaw(
      `INSERT INTO public."${TABLE}" (code) VALUES ('raw1'); SELECT code FROM public."${TABLE}" WHERE code = 'raw1'`,
    );
    expect(result.rows).toEqual([{ code: "raw1" }]);
    expect(result.fields.map((f) => f.name)).toEqual(["code"]);
  });

  it("queryRaw captures NOTICE messages (unlike a plain pool.query call)", async () => {
    const result = await database.queryRaw(`DO $$ BEGIN RAISE NOTICE 'raw notice'; END $$`);
    expect(result.notices.some((n) => n.message.includes("raw notice"))).toBe(true);
  });

  it("transactionRaw rolls back every statement in the script when a later one fails", async () => {
    await expect(
      database.transactionRaw((client) =>
        client.queryRaw(`INSERT INTO public."${TABLE}" (code) VALUES ('raw2'); SELECT 1/0`),
      ),
    ).rejects.toThrow();

    const { rows } = await database.query(`SELECT code FROM public."${TABLE}" WHERE code = 'raw2'`);
    expect(rows).toHaveLength(0);
  });
});
