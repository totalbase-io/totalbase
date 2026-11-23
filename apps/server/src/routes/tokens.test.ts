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
  // Allowed addresses (Security.md §3.5), set at creation and changed as a plain row through the Data API.
  it("issues a token with allowed addresses, refuses it from elsewhere on both planes, and lets an administrator change them", async () => {
    const created = await call("POST", "/api/tokens", { data: { name: `${PREFIX}-ips`, plane: "ADMIN", ttlDays: 1, allowedIps: ["203.0.113.7", "10.50.0.0/16"] } });
    expect(created.statusCode, created.body).toBe(201);
    const { id, key, allowedIps } = created.json().data as { id: string; key: string; allowedIps: string[] };
    expect(allowedIps).toEqual(["203.0.113.7", "10.50.0.0/16"]);
    const from = (ip: string, url: string) => app.inject({ method: "GET", url, remoteAddress: ip, headers: { authorization: `Bearer ${key}` } });

    for (const url of ["/admin/api/auth/me", "/api/totalbase/table/roles?limit=1"]) {
      expect((await from("203.0.113.7", url)).statusCode, url).toBe(200);
      expect((await from("10.50.3.4", url)).statusCode, url).toBe(200);
      const refused = await from("203.0.113.8", url);
      expect([refused.statusCode, refused.json().errors[0].code], url).toEqual([403, "TOKEN_IP_NOT_ALLOWED"]);
    }

    // The list reads them; a PATCH of the row replaces them, and null lifts the restriction.
    const listed = await call("GET", "/api/tokens");
    expect((listed.json().data as Array<{ id: string; allowedIps: string[] | null }>).find((t) => t.id === id)?.allowedIps).toEqual(["203.0.113.7", "10.50.0.0/16"]);
    const patch = (allowed: unknown) => app.inject({ method: "PATCH", url: `/api/totalbase/table/tokens/${id}`, headers: { authorization: `Bearer ${token}` }, payload: { data: { allowed_ips: allowed } } });
    const narrowed = await patch(["203.0.113.8"]);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect((await from("203.0.113.8", "/admin/api/auth/me")).statusCode).toBe(200);
    expect((await from("203.0.113.7", "/admin/api/auth/me")).statusCode).toBe(403);
    expect((await patch(["nope"])).statusCode).toBe(400);
    expect((await patch(null)).statusCode).toBe(200);
    expect((await from("198.51.100.20", "/admin/api/auth/me")).statusCode).toBe(200);

    expect((await call("POST", "/api/tokens", { data: { name: `${PREFIX}-ips-bad`, ttlDays: 1, allowedIps: ["nope"] } })).statusCode).toBe(400);
    expect((await call("DELETE", `/api/tokens/${id}`)).statusCode).toBe(204);
  });
  // Security regression (MCP-1, MCP-2): an agent's ADMIN token minted itself an unrestricted ADMIN sibling, and cleared
  // its own allowed addresses through the Data API - a token's containment contained nothing.
  it("lets no token issue or regenerate an ADMIN token, nor change a token's allowed addresses", async () => {
    const created = await call("POST", "/api/tokens", { data: { name: `${PREFIX}-agent`, plane: "ADMIN", ttlDays: 1, allowedIps: ["127.0.0.1"] } });
    expect(created.statusCode, created.body).toBe(201);
    const { id, key } = created.json().data as { id: string; key: string };
    const me = await context.auth.me(token);
    const asAgent = (method: "POST" | "PATCH", url: string, data: unknown) =>
      app.inject({ method, url, remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${key}` }, payload: { data } });

    const minted = await asAgent("POST", "/admin/api/tokens", { userId: me.id, name: `${PREFIX}-sibling`, plane: "ADMIN", ttlDays: 3650, allowedIps: null });
    expect([minted.statusCode, minted.json().errors?.[0]?.code]).toEqual([403, "PERMISSION_DENIED"]);
    const rotated = await asAgent("POST", `/admin/api/tokens/${id}/rotate`, { ttlDays: 3650 });
    expect([rotated.statusCode, rotated.json().errors?.[0]?.code]).toEqual([403, "PERMISSION_DENIED"]);
    // The self-service routes are a session's: the token isn't one.
    expect((await asAgent("POST", "/api/tokens", { name: `${PREFIX}-self`, plane: "ADMIN" })).statusCode).toBe(401);
    const lifted = await asAgent("PATCH", `/api/totalbase/table/tokens/${id}`, { allowed_ips: null });
    expect([lifted.statusCode, lifted.json().errors?.[0]?.code]).toEqual([403, "PERMISSION_DENIED"]);
    // An API-plane token it may still issue - narrower than itself, its owner's live roles.
    const narrow = await asAgent("POST", "/admin/api/tokens", { userId: me.id, name: `${PREFIX}-narrow`, plane: "API", ttlDays: 1 });
    expect(narrow.statusCode, narrow.body).toBe(201);
    const { rows } = await database.query<{ allowed_ips: string[] | null }>(`SELECT allowed_ips::text[] FROM totalbase.tokens WHERE id = $1`, [id]);
    expect(rows[0]!.allowed_ips).toEqual(["127.0.0.1/32"]);
  });

  // Refused tokens in the audit log (Security.md §11.6): a secret that is some token's, never an invented one.
  it("records a refused token as auth.token_refused, with its reason - once a minute per token and reason", async () => {
    const created = await call("POST", "/api/tokens", { data: { name: `${PREFIX}-refused`, ttlDays: 1, allowedIps: ["203.0.113.7"] } });
    const { id, key } = created.json().data as { id: string; key: string };
    const use = (ip: string, bearer = key) => app.inject({ method: "GET", url: "/api/totalbase/table/roles?limit=1&where[name][_neq]=in-the-url", remoteAddress: ip, headers: { authorization: `Bearer ${bearer}` } });
    const entries = async () => {
      // Written after the response is sent.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (await database.query<{ status: string; principal_type: string; ip: string; metadata: Record<string, unknown> }>(
        `SELECT status, principal_type, host(ip) AS ip, metadata FROM totalbase.logs WHERE principal = $1 AND metadata->>'event' = 'auth.token_refused' ORDER BY started_at`, [id],
      )).rows;
    };

    expect((await use("198.51.100.4")).statusCode).toBe(403);
    expect((await use("198.51.100.4")).statusCode).toBe(403);
    let rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "DENIED", principal_type: "API_KEY", ip: "198.51.100.4" });
    expect(rows[0]!.metadata).toMatchObject({ reason: "ip_not_allowed", route: "/api/:schema/table/:resource", method: "GET", statusCode: 403 });
    expect(JSON.stringify(rows[0])).not.toContain("in-the-url");
    expect(JSON.stringify(rows[0])).not.toContain(key);

    // An accepted use records nothing; a revoked token is another reason, recorded at once.
    expect((await use("203.0.113.7")).statusCode).toBe(200);
    expect((await call("POST", `/api/tokens/${id}/revoke`)).statusCode).toBe(204);
    expect((await use("203.0.113.7")).statusCode).toBe(401);
    rows = await entries();
    expect(rows.map((row) => row.metadata.reason)).toEqual(["ip_not_allowed", "revoked"]);

    // An invented secret is nobody's: nothing to record.
    const before = (await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM totalbase.logs WHERE metadata->>'event' = 'auth.token_refused'`)).rows[0]!.count;
    expect((await use("203.0.113.7", "tb_invented-secret-that-is-nobodys")).statusCode).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM totalbase.logs WHERE metadata->>'event' = 'auth.token_refused'`)).rows[0]!.count).toBe(before);
    expect((await call("DELETE", `/api/tokens/${id}`)).statusCode).toBe(204);
  });
});
