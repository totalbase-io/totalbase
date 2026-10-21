import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const PREFIX = "self-tokens-test";

/**
 * The self-service /api/tokens routes under the body contract (Data_API.md §2.5):
 * bodies in `{ data }`, 201 on create, 204 for revoke
 * and delete, 404 for a token that isn't the caller's.
 */
describe("Self-service API tokens", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;

  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload }) });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    token = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    const me = await context.auth.me(token);
    await database.query(`DELETE FROM totalbase.tokens WHERE "user" = $1 AND name LIKE '${PREFIX}%'`, [me.id]);
    await app.close();
  });

  it("creates, rotates, revokes and deletes a token in the { data } envelope", async () => {
    const created = await call("POST", "/api/tokens", { data: { name: `${PREFIX}-a`, ttlDays: 1 } });
    expect(created.statusCode, created.body).toBe(201);
    const { id, key } = created.json().data as { id: string; key: string };
    expect(key).toBeTruthy();

    // The old unwrapped body is not read.
    expect((await call("POST", "/api/tokens", { name: `${PREFIX}-b` })).statusCode).toBe(400);

    const rotated = await call("POST", `/api/tokens/${id}/rotate`, { data: { ttlDays: 2 } });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().data.key).not.toBe(key);

    const revoked = await call("POST", `/api/tokens/${id}/revoke`);
    expect([revoked.statusCode, revoked.body]).toEqual([204, ""]);

    expect((await call("DELETE", `/api/tokens/${id}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/api/tokens/${id}`)).statusCode).toBe(404);
    expect((await call("POST", `/api/tokens/${id}/revoke`)).statusCode).toBe(404);
  });
});
