import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { reconcileCatalog } from "../catalog-refresh.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const TABLE = "edit_presentation_test_items";

/**
 * A column's panel saves its structure and its presentation as one: the ALTERs first, then the presentation, in
 * one transaction - if either fails, neither applies (Administration.md §3.11).
 */
describe("table edit with a column's presentation (integration)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let resourceId: string;

  const edit = (payload: unknown) =>
    app.inject({ method: "POST", url: `/admin/api/schema/public/tables/${TABLE}/edit`, payload: { data: payload }, headers: { authorization: `Bearer ${adminToken}` } });
  const presentationOf = async (column: string) =>
    (await database.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM totalbase.resources_columns WHERE resource = $1 AND name = $2`,
      [resourceId, column],
    )).rows[0]?.config ?? null;
  const columnType = async (column: string) =>
    (await database.query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`,
      [`public.${TABLE}`, column],
    )).rows[0]?.type ?? null;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, amount text, note text)`);
    await database.query(`INSERT INTO public.${TABLE} (amount, note) VALUES ('12.5', 'a'), ('not a number', 'b')`);
    await reconcileCatalog(context);
    resourceId = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'public' AND name = $1 AND status = 'ACTIVE'`,
      [TABLE],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
  });

  it("renames a column and saves its presentation under the new name, together", async () => {
    const res = await edit({
      operations: [{ kind: "alter_column", column: "note", patch: { rename: "remark" } }],
      columnPresentation: { column: "remark", presentation: { label: "Remark" } },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(await columnType("remark")).toBe("text");
    expect(await presentationOf("remark")).toMatchObject({ label: "Remark" });
  });

  it("saves nothing when the ALTER fails - the presentation waits for it", async () => {
    const res = await edit({
      operations: [{ kind: "alter_column", column: "amount", patch: { dataType: "numeric" } }],
      columnPresentation: { column: "amount", presentation: { label: "Amount" } },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await columnType("amount")).toBe("text");
    expect(await presentationOf("amount")).toBeNull();
  });

  it("rolls the ALTER back when the presentation is refused", async () => {
    const res = await edit({
      operations: [{ kind: "alter_column", column: "remark", patch: { rename: "comment" } }],
      columnPresentation: { column: "comment", presentation: { displayFormat: "NOT_A_FORMAT" } },
    });
    expect(res.statusCode).toBe(422);
    expect(await columnType("remark")).toBe("text");
    expect(await columnType("comment")).toBeNull();
  });
});
