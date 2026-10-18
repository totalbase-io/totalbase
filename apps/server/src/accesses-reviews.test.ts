import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

const P = "access-review-test";
const REVIEWS = "/api/totalbase/table/roles_reviews";

/**
 * Periodic access review (Specification_Security.md §1.8): an attestation
 * recorded through the Data API by administrators only, whose reviewer and
 * member snapshot PostgreSQL fills in, immutable once written.
 */
describe("Access reviews", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let adminUserId: string;
  let roleId: string;
  let member: { plainKey: string; userId: string; tokenId: string };

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
    adminUserId = login.user.id;
    // A reconcile registers the table with its fixed exposure.
    expect((await call("POST", "/admin/api/catalog/refresh", adminToken)).statusCode).toBeLessThan(300);
    roleId = (await context.roles.create(`${P}-role`, { apiAccess: true })).id;
    member = await createTestApiToken(context, { name: `${P}-member`, roleId, email: `${P}-member@example.com` });
    // Even a CREATE grant on the table doesn't let a non-administrator attest.
    const resourceId = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'roles_reviews'`,
    )).rows[0]!.id;
    await context.permissions.set(roleId, resourceId, "CREATE", { effect: "ALLOW" });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [member.userId]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [roleId]);
    // Cascades to its reviews.
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
    await database.close();
  });

  it("records the reviewer and the members from PostgreSQL, not from the request", async () => {
    const res = await call("POST", REVIEWS, adminToken, {
      data: { role: roleId, outcome: "NO_CHANGES", note: "Quarterly review", reviewer: member.userId, members: [] },
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await database.query<{ reviewer: string; members: Array<{ id: string; email: string }>; outcome: string }>(
      `SELECT reviewer, members, outcome FROM totalbase.roles_reviews WHERE role = $1`,
      [roleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reviewer).toBe(adminUserId);
    expect(rows[0]!.members.map((m) => m.id)).toEqual([member.userId]);
    expect(rows[0]!.outcome).toBe("NO_CHANGES");

    const list = await call("GET", `${REVIEWS}?where[role][_eq]=${roleId}`, adminToken);
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    const withReviewer = await call("GET", `${REVIEWS}?where[role][_eq]=${roleId}&fields=id,reviewer.email`, adminToken);
    // The reviewer is a real FK: the Admin UI shows their email through it.
    expect(withReviewer.json().data[0]["reviewer.email"]).toBe(loadServerEnv().adminEmail!);
  });

  it("is administrator-written: a CREATE grant is not enough", async () => {
    const res = await call("POST", REVIEWS, member.plainKey, { data: { role: roleId, outcome: "NO_CHANGES" } });
    expect(res.statusCode).toBe(403);
  });

  it("is immutable: no PATCH through the Data API, no UPDATE in PostgreSQL", async () => {
    const id = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles_reviews WHERE role = $1`, [roleId])).rows[0]!.id;
    const patch = await call("PATCH", `${REVIEWS}/${id}`, adminToken, { data: { outcome: "CHANGES_MADE" } });
    expect(patch.statusCode).toBeGreaterThanOrEqual(400);
    await expect(database.query(`UPDATE totalbase.roles_reviews SET outcome = 'CHANGES_MADE' WHERE id = $1`, [id])).rejects.toThrow(/cannot be changed/);
  });

  it("rejects an unknown outcome (CHECK)", async () => {
    const res = await call("POST", REVIEWS, adminToken, { data: { role: roleId, outcome: "MAYBE" } });
    expect(res.statusCode).toBe(422);
  });
});
