import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { createTestApiToken, setupTestApp } from "../test-support.js";

/**
 * POST /app/api/templates/preview-pdf - renders posted (unsaved) PDF
 * template content with each input field's own sample value. Admin-only;
 * nothing is stored.
 */
describe("POST /app/api/templates/preview-pdf", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  let apiKeyPlain: string;
  let apiKeyUserId: string;

  const content = {
    basePdf: { width: 210, height: 297, padding: [10, 10, 10, 10] },
    schemas: [[
      { name: "title", type: "text", content: "INVOICE", readOnly: true, position: { x: 20, y: 20 }, width: 80, height: 10 },
      { name: "customer_name", type: "text", content: "Globex", position: { x: 20, y: 40 }, width: 80, height: 10 },
    ]],
  };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;

    const role = await context.roles.create("admin-templates-preview-test-role", { apiAccess: true });
    roleId = role.id;
    const created = await createTestApiToken(context, {
      name: "admin-templates-preview-test-key",
      roleId,
      email: "admin-templates-preview-test-key@example.com",
    });
    apiKeyPlain = created.plainKey;
    apiKeyUserId = created.userId;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
    await database.close();
  });

  it("returns a PDF rendered from the posted content, storing nothing", async () => {
    const { rows: before } = await database.query<{ count: string }>(`SELECT count(*) FROM totalbase.templates`);
    const res = await app.inject({
      method: "POST",
      url: "/app/api/templates/preview-pdf",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { content } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const { rows: after } = await database.query<{ count: string }>(`SELECT count(*) FROM totalbase.templates`);
    expect(after[0]!.count).toBe(before[0]!.count);
  });

  it("rejects a non-admin caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/app/api/templates/preview-pdf",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { content } },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("rejects missing content with INVALID_QUERY", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/app/api/templates/preview-pdf",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe("INVALID_QUERY");
  });
});
