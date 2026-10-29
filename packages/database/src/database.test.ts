import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TotalBaseError } from "@totalbase/errors";
import type { Principal } from "@totalbase/shared";
import { Database } from "./database.js";
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
