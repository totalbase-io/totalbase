import type { FastifyInstance } from "fastify";
import { buildColumnCreationBody, COLUMN_INPUTS, creatableColumnInputs, type ColumnInputKey, type CreationConfig } from "@totalbase/tb-catalog";
import type { Database } from "@totalbase/database";
import { syncResourceColumns } from "@totalbase/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const RUN = Date.now().toString(36);
const TABLE = `ci_items_${RUN}`;
const TARGET = `ci_brands_${RUN}`;
const RAW = `ci_raw_${RUN}`;

/**
 * The column input catalog both ways (Specification_DataViews.md §16.1): every entry Add Column creates reads back
 * as itself - stored, and one the rule accepts for the column PostgreSQL made - and a table made in plain SQL gets
 * the rule's entry for each column (Automatic), with the entries that edit it.
 */
describe("Column inputs - created through Add Column, read back from PostgreSQL", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  const resourceIds: string[] = [];

  const call = (method: "GET" | "POST" | "PUT", url: string, data?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(data !== undefined && { payload: { data } }) });
  const register = async (name: string) => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status) VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [`public.${name}`, name],
    );
    resourceIds.push(rows[0]!.id);
    return rows[0]!.id;
  };
  type Column = { columnName: string; presentation: { input?: string }; automatic?: { input: string; reason: string }; inputs?: string[] };
  const columns = async (resourceId: string) => (await call("GET", `/admin/api/resources/${resourceId}/columns`)).json().data as Column[];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    token = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await database.query(`CREATE TABLE public.${TARGET} (id serial PRIMARY KEY, name text NOT NULL)`);
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, title text)`);
    await register(TARGET);
  });

  afterAll(async () => {
    for (const id of resourceIds) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}, public.${RAW}, public.${TARGET} CASCADE`);
    await app.close();
  });

  it("creates a column with every creatable entry, and reads each back as itself", async () => {
    const itemsId = await register(TABLE);
    const config = (key: ColumnInputKey): CreationConfig => {
      switch (COLUMN_INPUTS[key].create?.kind) {
        case "selection":
          return { options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] };
        case "uid":
          return { uidSource: "title" };
        case "relation":
          return { relation: { targetSchema: "public", targetTable: TARGET, targetColumn: "id", targetColumnDataType: "integer" } };
        default:
          return key === "slider" ? { min: 0, max: 10 } : key === "pin" ? { pinLength: 4 } : {};
      }
    };
    for (const key of creatableColumnInputs()) {
      const name = `c_${key.replace(/-/g, "_")}`;
      const body = buildColumnCreationBody(key, name, config(key));
      const res = await call("POST", `/admin/api/schema/public/tables/${TABLE}/columns`, { name, nullable: true, ...body, input: key, config: {} });
      expect(res.statusCode, `${key}: ${res.body}`).toBe(201);
    }
    const read = await columns(itemsId);
    for (const key of creatableColumnInputs()) {
      const column = read.find((c) => c.columnName === `c_${key.replace(/-/g, "_")}`)!;
      // Stored as chosen, and one the rule accepts for what PostgreSQL made of it.
      expect(column.presentation.input, key).toBe(key);
      if (key === "password") expect(column.inputs).toEqual(["password"]);
      else expect(column.inputs, key).toContain(key);
    }
    // A password column stays one; no other column becomes one.
    const password = await call("PUT", `/admin/api/resources/${itemsId}/columns/c_password/presentation`, { presentation: { input: "text" } });
    expect(password.statusCode).toBe(422);
    expect(password.json().errors[0].message).toMatch(/is a password column/);
    const kept = await call("PUT", `/admin/api/resources/${itemsId}/columns/c_password/presentation`, { presentation: { label: "Clave" } });
    expect(kept.json().data.presentation).toEqual({ label: "Clave", input: "password" });
    const made = await call("PUT", `/admin/api/resources/${itemsId}/columns/c_text/presentation`, { presentation: { input: "password" } });
    expect(made.json().errors[0].message).toMatch(/isn't a password column/);
  });

  it("gives a table made in plain SQL the rule's control for each column - and offers the ones that edit it", async () => {
    await database.query(`CREATE TABLE public.${RAW} (
      id serial PRIMARY KEY,
      amount numeric(12,2),
      qty integer CHECK (qty BETWEEN 1 AND 12),
      big integer,
      status text CHECK (status IN ('OPEN', 'DONE')),
      tags text[] CHECK (tags <@ ARRAY['a', 'b']),
      free_tags text[],
      contact text CHECK (contact ~* '^[^@]+@[^@]+\\.[^@]+$'),
      site text CHECK (site ~* '^https?://'),
      note text,
      active boolean,
      born date,
      seen_at timestamptz,
      opens time,
      period tstzrange,
      data jsonb,
      place point,
      brand integer REFERENCES public.${TARGET}(id),
      photo uuid REFERENCES totalbase.files(id)
    )`);
    const rawId = await register(RAW);
    // Pull writes each column's row with no control: Automatic.
    const { rows: oid } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${RAW}`]);
    await syncResourceColumns(database, rawId, oid[0]!.oid);
    const read = await columns(rawId);
    const auto = Object.fromEntries(read.map((c) => [c.columnName, [c.automatic?.input, c.automatic?.reason]]));
    expect(auto).toMatchObject({
      amount: ["number-field", "number"],
      qty: ["number-stepper", "small-range"],
      big: ["number-field", "number"],
      status: ["choice", "check-list"],
      tags: ["choice-multiple", "check-list"],
      free_tags: ["tags", "default"],
      contact: ["email", "pattern"],
      site: ["url", "pattern"],
      note: ["text", "default"],
      active: ["switch", "default"],
      born: ["date", "default"],
      seen_at: ["datetime", "default"],
      opens: ["time", "default"],
      period: ["range", "default"],
      data: ["json", "default"],
      place: ["coordinates", "default"],
      brand: ["relation-search", "relation"],
      photo: ["file", "file"],
    });
    const inputsOf = (name: string) => read.find((c) => c.columnName === name)!.inputs;
    expect(inputsOf("brand")).toEqual(["relation-search", "relation-select"]);
    expect(inputsOf("amount")).toEqual(["number-field", "number-stepper", "slider", "rating"]);
    expect(inputsOf("status")).toEqual(expect.arrayContaining(["choice", "choice-radio", "choice-search", "text"]));
    expect(inputsOf("note")).not.toContain("password");
    // Chosen on the Columns tab, kept; Automatic again with none.
    await call("PUT", `/admin/api/resources/${rawId}/columns/brand/presentation`, { presentation: { input: "relation-select" } });
    expect((await columns(rawId)).find((c) => c.columnName === "brand")!.presentation.input).toBe("relation-select");
    const wrong = await call("PUT", `/admin/api/resources/${rawId}/columns/amount/presentation`, { presentation: { input: "switch" } });
    expect(wrong.json().errors[0].message).toMatch(/Input "switch" doesn't edit a number column/);
  });
});
