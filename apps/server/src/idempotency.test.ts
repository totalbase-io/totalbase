import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

const SUFFIX = uniqueSuffix();

/**
 * Route-level acceptance tests for Idempotency Keys on the CREATE endpoint
 * (Data_API.md §9).
 */
describe("Idempotency Keys (POST create)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;

  let resourceId: string;
  let roleId: string;
  let apiKeyPlain: string;
  let apiKeyId: string;
  let apiKeyUserId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.idem_pkg_test_widgets CASCADE`);
    await database.query(`
      CREATE TABLE public.idem_pkg_test_widgets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL
      )
    `);
    const resource = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.idem_pkg_test_widgets')::oid, 'public', 'idem_pkg_test_widgets', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}')
       RETURNING id`,
    );
    resourceId = resource.rows[0]!.id;

    const role = await context.roles.create(`idem-pkg-test-role-${SUFFIX}`, { apiAccess: true });
    roleId = role.id;
    await context.permissions.set(roleId, resourceId, "READ", {
      effect: "ALLOW",
      fields: [
        { field: "id", effect: "ALLOW" },
        { field: "name", effect: "ALLOW" },
      ],
    });
    await context.permissions.set(roleId, resourceId, "CREATE", {
      effect: "ALLOW",
      fields: [{ field: "name", effect: "ALLOW" }],
    });

    const created = await createTestApiToken(context, {
      name: `idem-pkg-test-key-${SUFFIX}`,
      roleId,
      email: `idem-pkg-test-key-${SUFFIX}@example.com`,
    });
    apiKeyPlain = created.plainKey;
    apiKeyId = created.tokenId;
    apiKeyUserId = created.userId;
  });

  afterEach(async () => {
    await database.query(`DELETE FROM public.idem_pkg_test_widgets`);
    await database.query(`DELETE FROM totalbase.idempotency_keys WHERE principal = ANY($1)`, [[apiKeyId, apiKeyUserId]]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.idem_pkg_test_widgets CASCADE`);
    await app.close();
    await database.close();
  });

  function post(payload: unknown, idempotencyKey?: string) {
    return app.inject({
      method: "POST",
      url: "/api/public/table/idem_pkg_test_widgets",
      headers: {
        authorization: `Bearer ${apiKeyPlain}`,
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      payload: { data: payload },
    });
  }

  it("creates exactly one row when the same Idempotency-Key is retried", async () => {
    const first = await post({ name: "widget-a" }, "key-1");
    expect(first.statusCode).toBe(201);
    const second = await post({ name: "widget-a" }, "key-1");
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    const { rows } = await database.query(`SELECT * FROM public.idem_pkg_test_widgets`);
    expect(rows).toHaveLength(1);
  });

  it("rejects the same key reused with a different body", async () => {
    await post({ name: "widget-b" }, "key-2");
    const conflict = await post({ name: "widget-different" }, "key-2");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().errors[0].code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects a malformed key with 400 INVALID_IDEMPOTENCY_KEY and writes nothing", async () => {
    const malformed = await post({ name: "widget-bad-key" }, "has spaces/and slashes");
    expect([malformed.statusCode, malformed.json().errors[0].code]).toEqual([400, "INVALID_IDEMPOTENCY_KEY"]);
    const { rows } = await database.query(`SELECT * FROM public.idem_pkg_test_widgets`);
    expect(rows).toHaveLength(0);
  });

  it("creates a separate row per request when no Idempotency-Key is sent", async () => {
    await post({ name: "widget-c" });
    await post({ name: "widget-c" });
    const { rows } = await database.query(`SELECT * FROM public.idem_pkg_test_widgets WHERE name = 'widget-c'`);
    expect(rows).toHaveLength(2);
  });

  it("does not create a row when the operation itself fails, and allows a clean retry", async () => {
    const failed = await post({}, "key-3"); // missing NOT NULL name -> DB error
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);

    const retried = await post({ name: "widget-d" }, "key-3");
    expect(retried.statusCode).toBe(201);

    const { rows } = await database.query(`SELECT * FROM public.idem_pkg_test_widgets WHERE name = 'widget-d'`);
    expect(rows).toHaveLength(1);
  });
});
