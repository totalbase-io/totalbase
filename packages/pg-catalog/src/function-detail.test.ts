import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFunctionDetail } from "./function-detail.js";

const SCHEMA = `function_detail_test_${process.pid}`;

describe("getFunctionDetail (integration)", () => {
  let database: Database;
  const oidOf = async (name: string) =>
    (await database.query<{ oid: number }>(`SELECT p.oid::int AS oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`, [SCHEMA, name])).rows[0]!.oid;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`CREATE SCHEMA "${SCHEMA}"`);
    await database.query(`CREATE TYPE "${SCHEMA}".pair AS (label text, amount numeric(10,2))`);
    await database.query(`CREATE FUNCTION "${SCHEMA}".scalar(x int DEFAULT 1) RETURNS bigint LANGUAGE sql AS 'SELECT x::bigint'`);
    await database.query(`CREATE FUNCTION "${SCHEMA}".nothing() RETURNS void LANGUAGE sql AS ''`);
    await database.query(`CREATE FUNCTION "${SCHEMA}".tabled(n int) RETURNS TABLE (id int, name text) LANGUAGE sql AS 'SELECT n, ''x'''`);
    await database.query(`CREATE FUNCTION "${SCHEMA}".composite() RETURNS "${SCHEMA}".pair LANGUAGE sql AS 'SELECT ''a'', 1.5'`);
    await database.query(`CREATE FUNCTION "${SCHEMA}".numbers() RETURNS SETOF int LANGUAGE sql AS 'SELECT 1'`);
    await database.query(`CREATE FUNCTION "${SCHEMA}".records() RETURNS SETOF record LANGUAGE sql AS 'SELECT 1'`);
  });

  afterAll(async () => {
    await database.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await database.close();
  });

  it("types a scalar result, and leaves a pseudo-type's out", async () => {
    expect(await getFunctionDetail(database, await oidOf("scalar"))).toEqual({
      parameters: [{ name: "x", dataType: "integer", hasDefault: true }],
      returnsRows: false,
      resultColumns: null,
      resultType: "bigint",
    });
    expect(await getFunctionDetail(database, await oidOf("nothing"))).toEqual({ parameters: [], returnsRows: false, resultColumns: null, resultType: null });
  });

  it("lists a row result's columns as SELECT * FROM names them - TABLE parameters, a composite type, SETOF a scalar", async () => {
    expect(await getFunctionDetail(database, await oidOf("tabled"))).toEqual({
      parameters: [{ name: "n", dataType: "integer", hasDefault: false }],
      returnsRows: true,
      resultColumns: [{ name: "id", dataType: "integer" }, { name: "name", dataType: "text" }],
      resultType: null,
    });
    expect((await getFunctionDetail(database, await oidOf("composite"))).resultColumns).toEqual([
      { name: "label", dataType: "text" },
      { name: "amount", dataType: "numeric(10,2)" },
    ]);
    expect((await getFunctionDetail(database, await oidOf("numbers"))).resultColumns).toEqual([{ name: "numbers", dataType: "integer" }]);
    // PostgreSQL declares no columns for SETOF record.
    expect(await getFunctionDetail(database, await oidOf("records"))).toEqual({ parameters: [], returnsRows: true, resultColumns: null, resultType: null });
  });
});
