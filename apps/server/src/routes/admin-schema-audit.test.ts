import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const TABLE = "ddl_audit_test_items";
const VIEW = "ddl_audit_test_view";

interface DdlEntry {
  id: string;
  resource: string | null;
  status: string;
  principal_type: string;
  metadata: { operation: string; schema?: string; table?: string; name?: string; statements?: string[]; concurrent?: boolean };
  error_code: string | null;
}

/** Schema management writes one DDL audit entry per operation, on the DDL's own transaction (Administration.md §3.14). */
describe("schema management DDL audit (integration)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const seen = new Set<string>();

  const call = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${adminToken}` } });

  /** DDL entries for the test table/view written since the last call. */
  const newEntries = async (): Promise<DdlEntry[]> => {
    const { rows } = await database.query<DdlEntry>(
      `SELECT id, resource, status, principal_type, metadata, error_code FROM totalbase.logs
       WHERE action = 'DDL' AND (metadata->>'table' = $1 OR metadata->>'name' = $2)
       ORDER BY created_at, id`,
      [TABLE, VIEW],
    );
    const fresh = rows.filter((row) => !seen.has(row.id));
    for (const row of fresh) seen.add(row.id);
    return fresh;
  };
  const resourceIdOf = async (name: string) =>
    (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'public' AND name = $1 AND status = 'ACTIVE'`,
      [name],
    )).rows[0]?.id;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await newEntries(); // leftovers of an earlier run don't count
  });

  afterAll(async () => {
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    if (seen.size > 0) await database.query(`DELETE FROM totalbase.logs WHERE id = ANY($1::uuid[])`, [[...seen]]);
    await app.close();
    await database.close();
  });

  it("create table: one EXECUTED entry with the operation and its statements", async () => {
    const res = await call("POST", "/admin/api/schema/public/tables", {
      data: { name: TABLE, columns: [{ name: "id", dataType: "integer", primaryKey: true }, { name: "price", dataType: "numeric" }] },
    });
    expect(res.statusCode).toBe(201);
    const entries = await newEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "EXECUTED", principal_type: "ADMIN", metadata: { operation: "create_table", schema: "public", table: TABLE } });
    expect(entries[0]!.metadata.statements![0]).toMatch(/^create table "public"\."ddl_audit_test_items"/i);
  });

  it("add column: the entry names the table's resource", async () => {
    const res = await call("POST", `/admin/api/schema/public/tables/${TABLE}/columns`, { data: { name: "label", dataType: "text" } });
    expect(res.statusCode).toBe(201);
    const [entry] = await newEntries();
    expect(entry).toMatchObject({ status: "EXECUTED", resource: await resourceIdOf(TABLE), metadata: { operation: "add_column" } });
    expect(entry!.metadata.statements!.join(" ")).toContain('"label" text');
  });

  it("a DDL its audit entry can't be written with is rolled back - same transaction", async () => {
    const record = context.audit.record.bind(context.audit);
    context.audit.record = async () => {
      throw new Error("audit unavailable");
    };
    try {
      const res = await call("POST", `/admin/api/schema/public/tables/${TABLE}/columns`, { data: { name: "ghost", dataType: "text" } });
      expect(res.statusCode).toBe(500);
    } finally {
      context.audit.record = record;
    }
    const { rows } = await database.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'ghost'`,
      [TABLE],
    );
    expect(rows).toHaveLength(0);
    await newEntries();
  });

  it("a failing operation is recorded FAILED with PostgreSQL's error, and nothing EXECUTED", async () => {
    await database.query(`INSERT INTO public.${TABLE} (id, price) VALUES (1, -5)`);
    const res = await call("POST", `/admin/api/schema/public/tables/${TABLE}/checks`, { data: { name: "price_positive", expression: "price > 0" } });
    expect(res.statusCode).toBe(422);
    const entries = await newEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "FAILED", error_code: "CHECK_VIOLATION", metadata: { operation: "add_check", table: TABLE } });
  });

  it("an edit batch: the transactional half in one entry, each CONCURRENTLY statement in its own after it ran", async () => {
    const res = await call("POST", `/admin/api/schema/public/tables/${TABLE}/edit`, {
      data: {
        operations: [
          { kind: "add_column", column: { name: "sku", dataType: "text" } },
          { kind: "add_unique", columns: ["sku"] },
          { kind: "create_index", name: "ddl_audit_test_label_idx", columns: ["label"], concurrently: true },
        ],
      },
    });
    expect(res.statusCode).toBe(204);
    const entries = await newEntries();
    expect(entries.map((e) => [e.metadata.operation, e.metadata.concurrent ?? false, e.metadata.statements!.length])).toEqual([
      ["edit_table", false, 2],
      ["edit_table", true, 1],
    ]);
    expect(entries[1]!.metadata.statements![0]).toContain("CREATE INDEX CONCURRENTLY");
  });

  it("primary key, constraint and column routes are audited too", async () => {
    expect((await call("DELETE", `/admin/api/schema/public/tables/${TABLE}/unique-constraints/${TABLE}_sku_key`)).statusCode).toBe(204);
    expect((await call("DELETE", `/admin/api/schema/public/tables/${TABLE}/primary-key`)).statusCode).toBe(204);
    expect((await call("PATCH", `/admin/api/schema/public/tables/${TABLE}/columns/label`, { data: { default: "'none'" } })).statusCode).toBe(204);
    const operations = (await newEntries()).map((e) => [e.metadata.operation, e.status]);
    expect(operations).toEqual([
      ["drop_constraint", "EXECUTED"],
      ["drop_primary_key", "EXECUTED"],
      ["alter_column", "EXECUTED"],
    ]);
  });

  // A dropped object's resource is purged by the reconcile that follows,
  // clearing the entry's `resource` (ON DELETE SET NULL) - its names stay
  // in metadata. While the object exists the entry names its resource.
  it("drop view: named by schema and name, and its resource while it existed", async () => {
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT id FROM public.${TABLE}`);
    await call("POST", "/admin/api/catalog/refresh");
    const viewId = await resourceIdOf(VIEW);
    expect(viewId).toBeDefined();
    expect((await call("DELETE", `/admin/api/schema/views/${viewId}`)).statusCode).toBe(204);
    const [entry] = await newEntries();
    expect(entry).toMatchObject({ status: "EXECUTED", metadata: { operation: "drop_view", schema: "public", name: VIEW } });
    expect(entry!.metadata.statements![0]).toBe(`DROP VIEW ${VIEW}`);
  });

  it("drop table: the entry is written with the dropped table's resource", async () => {
    const tableId = await resourceIdOf(TABLE);
    // Read inside the DDL's transaction, before the reconcile purges it -
    // observed at the moment the entry is written.
    const seenResource: Array<string | undefined> = [];
    const record = context.audit.record.bind(context.audit);
    context.audit.record = async (client, entry) => {
      seenResource.push(entry.resourceId);
      return record(client, entry);
    };
    try {
      expect((await call("DELETE", `/admin/api/schema/public/tables/${TABLE}`)).statusCode).toBe(204);
    } finally {
      context.audit.record = record;
    }
    expect(seenResource).toEqual([tableId]);
    const [entry] = await newEntries();
    expect(entry).toMatchObject({ status: "EXECUTED", metadata: { operation: "drop_table", schema: "public", table: TABLE } });
  });
});
