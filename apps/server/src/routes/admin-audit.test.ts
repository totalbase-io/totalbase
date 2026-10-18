import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

/**
 * GET /admin/api/audit/logs and /summary: malformed parameters are
 * rejected at the edge (400 INVALID_QUERY) instead of reaching PostgreSQL,
 * and comma-separated lists / ".*" event prefixes reach the query service.
 * The filtering itself is covered against PostgreSQL in
 * packages/audit/src/audit-query-service.test.ts.
 */
describe("admin audit routes", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let adminToken: string;

  function get(url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${adminToken}` } });
  }

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    const env = loadServerEnv();
    // Signing in writes an auth.portal_login-style access entry of its own.
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ["since=yesterday", "since"],
    ["until=2026-13-45T99:00:00Z", "until"],
    ["before=not-a-date", "before"],
    ["limit=abc", "limit"],
    ["offset=-5", "offset"],
  ])("rejects %s with 400 INVALID_QUERY", async (query, name) => {
    for (const path of ["/admin/api/audit/logs", "/admin/api/audit/logs/summary"]) {
      const res = await get(`${path}?${query}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0]).toMatchObject({ code: "INVALID_QUERY" });
      expect(res.json().errors[0].message).toContain(name);
    }
  });

  it("returns a capped-count flag with the page", async () => {
    const res = await get(`/admin/api/audit/logs?limit=1&since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toMatchObject({ totalCapped: false });
    expect(typeof res.json().meta.total).toBe("number");
  });

  it("accepts action/status lists and event prefixes", async () => {
    const res = await get("/admin/api/audit/logs?action=CREATE,UPDATE,DELETE&status=EXECUTED,DENIED&event=permission.*,user.roles_set");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it("returns faceted counts from /summary", async () => {
    const res = await get("/admin/api/audit/logs/summary?action=AUTH");
    expect(res.statusCode).toBe(200);
    const { byStatus, byPrincipalType, byAction } = res.json().data;
    expect(byStatus).toBeTypeOf("object");
    expect(byPrincipalType).toBeTypeOf("object");
    // The action facet ignores action=AUTH, so other actions may appear too;
    // the other facets only count AUTH entries.
    expect(byAction).toBeTypeOf("object");
    const authTotal = Object.values(byStatus as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(authTotal).toBe(byAction.AUTH ?? 0);
  });

  it("requires an admin", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/audit/logs/summary" });
    expect(res.statusCode).toBe(401);
  });

  it("answers 404 for an unknown resource's audit exclusions, read or written", async () => {
    const url = "/admin/api/resources/00000000-0000-4000-8000-000000000000/audit";
    const read = await get(url);
    expect([read.statusCode, read.json().errors[0].code]).toEqual([404, "RESOURCE_NOT_FOUND"]);
    const write = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { excludedFields: [] } },
    });
    expect([write.statusCode, write.json().errors[0].code]).toEqual([404, "RESOURCE_NOT_FOUND"]);
  });

  it("refuses an exclusion that isn't a column of the resource, or a body without the list", async () => {
    const { rows } = await context.database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'roles'`,
    );
    const url = `/admin/api/resources/${rows[0]!.id}/audit`;
    const put = (data: unknown) => app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${adminToken}` }, payload: { data } as object });
    for (const data of [{ excludedFields: ["no_such_column"] }, { action: "UPDATE", fields: [] }]) {
      const res = await put(data);
      expect([res.statusCode, res.json().errors[0].code], JSON.stringify(data)).toEqual([400, "INVALID_QUERY"]);
    }
    expect((await get(url)).json().data).toEqual({ excludedFields: [] });
  });
});
