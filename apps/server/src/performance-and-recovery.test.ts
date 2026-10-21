import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Lightweight performance sanity checks and failure-recovery regression
 * tests (Foundations.md §21, §23: "performance tests",
 * "failure recovery"). Not a load-testing harness - these are smoke-
 * level bounds against the real integration Postgres, meant to catch a
 * gross regression (e.g. an accidental N+1 query), not to benchmark.
 */
describe("Performance sanity and failure recovery", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let resourceId: string;
  let apiKeyPlain: string;
  let roleId: string;
  let apiKeyId: string;
  let apiKeyUserId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.perf_pkg_test_items CASCADE`);
    await database.query(`
      CREATE TABLE public.perf_pkg_test_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        n integer NOT NULL,
        label text NOT NULL
      )
    `);

    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.perf_pkg_test_items')::oid, 'public', 'perf_pkg_test_items', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}')
       RETURNING id`,
    );
    resourceId = rows[0]!.id;

    const role = await context.roles.create("perf-pkg-test-role", { apiAccess: true });
    roleId = role.id;
    await context.permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", fields: [
      { field: "id", effect: "ALLOW" },
      { field: "n", effect: "ALLOW" },
      { field: "label", effect: "ALLOW" },
    ] });
    await context.permissions.set(roleId, resourceId, "CREATE", { effect: "ALLOW", fields: [
      { field: "n", effect: "ALLOW" },
      { field: "label", effect: "ALLOW" },
    ] });

    const created = await createTestApiToken(context, {
      name: "perf-pkg-test-key",
      roleId,
      email: "perf-pkg-test-key@example.com",
    });
    apiKeyPlain = created.plainKey;
    apiKeyId = created.tokenId;
    apiKeyUserId = created.userId;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.perf_pkg_test_items CASCADE`);
    await app.close();
    await database.close();
  });

  describe("Performance sanity", () => {
    it("bulk-creates api.bulk_max_items (500) rows in one call within a reasonable bound", async () => {
      const items = Array.from({ length: 500 }, (_, i) => ({ n: i, label: `item-${i}` }));
      const startedAt = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/perf_pkg_test_items?bulk=true",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: { data: items },
      });
      const durationMs = Date.now() - startedAt;

      expect(res.statusCode).toBe(201);
      expect(res.json().data).toHaveLength(500);
      expect(durationMs).toBeLessThan(5000);

      const { rows } = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.perf_pkg_test_items`,
      );
      expect(Number(rows[0]?.count)).toBe(500);
    });

    it("reads a filtered, ordered, paginated slice of the seeded rows quickly", async () => {
      const startedAt = Date.now();
      const res = await app.inject({
        method: "GET",
        url: "/api/public/table/perf_pkg_test_items?where[n][_gte]=100&order_by=n&limit=50&count=true",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
      });
      const durationMs = Date.now() - startedAt;

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(50);
      expect(body.meta.count).toBe(400); // n in [100, 499]
      expect(durationMs).toBeLessThan(1000);
    });
  });

  describe("Failure recovery", () => {
    it("rolls back the entire bulk batch when one item violates a NOT NULL constraint", async () => {
      await database.query(`DELETE FROM public.perf_pkg_test_items WHERE label LIKE 'atomic-%'`);

      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/perf_pkg_test_items?bulk=true",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: {
          data: [
            { n: 1, label: "atomic-1" },
            { n: 2, label: "atomic-2" },
            { n: null, label: "atomic-3" }, // violates NOT NULL
          ],
        },
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const { rows } = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.perf_pkg_test_items WHERE label LIKE 'atomic-%'`,
      );
      expect(Number(rows[0]?.count)).toBe(0); // none of the 3 survived, including the 2 valid ones
    });
  });
});
