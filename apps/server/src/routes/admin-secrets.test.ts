import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { adminToken as loginAdmin, setupTestApp, waitFor } from "../test-support.js";

const PREFIX = "admin-secrets-test";
const PLAINTEXT = "very-secret-value-12345";

/**
 * Settings > Secrets and Auth providers over HTTP. A secret is write-only
 * from every surface - no route, list or audit row ever carries its value,
 * and PostgreSQL only holds the ciphertext; an auth provider holds a
 * reference to one, never the client secret itself.
 */
describe("Admin secrets and auth providers", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;

  /** `data` goes in the `{ data }` request envelope. */
  const call = (method: string, url: string, data?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${adminToken}` },
      ...(data !== undefined && { payload: { data } as Record<string, unknown> }),
    });

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.providers WHERE name LIKE 'Admin secrets test%'`);
    await database.query(`DELETE FROM totalbase.secrets WHERE key LIKE '${PREFIX}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    adminToken = await loginAdmin(context);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("stores a secret encrypted and never returns its value", async () => {
    const put = await call("PUT", `/admin/api/secrets/${PREFIX}-key`, { value: PLAINTEXT });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.body).not.toContain(PLAINTEXT);
    expect(put.json().data).toMatchObject({ key: `${PREFIX}-key` });

    const list = await call("GET", "/admin/api/secrets");
    expect(list.body).not.toContain(PLAINTEXT);
    expect(list.json().data.some((s: { key: string }) => s.key === `${PREFIX}-key`)).toBe(true);

    const { rows } = await database.query<{ ciphertext: string }>(`SELECT ciphertext FROM totalbase.secrets WHERE key = $1`, [`${PREFIX}-key`]);
    expect(rows[0]!.ciphertext).not.toContain(PLAINTEXT);
    expect(await context.secrets.decrypt(`${PREFIX}-key`)).toBe(PLAINTEXT);
  });

  it("keeps the value out of the audit log", async () => {
    // A key of its own per run - audit rows outlive the test.
    const key = `${PREFIX}-audited-${Date.now()}`;
    await call("PUT", `/admin/api/secrets/${key}`, { value: PLAINTEXT });
    // Written after the response.
    const rows = await waitFor(async () => {
      const found = (await database.query<{ payload: unknown; metadata: unknown }>(
        `SELECT payload, metadata FROM totalbase.logs WHERE metadata->>'event' = 'secret.set' AND metadata->'params'->>'key' = $1`,
        [key],
      )).rows;
      return found.length > 0 ? found : undefined;
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(PLAINTEXT);
    expect(rows[0]!.payload).toEqual({ value: "[redacted]" });
  });

  it("deletes a secret", async () => {
    await call("PUT", `/admin/api/secrets/${PREFIX}-gone`, { value: "x" });
    expect((await call("DELETE", `/admin/api/secrets/${PREFIX}-gone`)).statusCode).toBe(204);
    expect(await context.secrets.exists(`${PREFIX}-gone`)).toBe(false);
    // Already gone: 404, not a silent 204.
    const again = await call("DELETE", `/admin/api/secrets/${PREFIX}-gone`);
    expect([again.statusCode, again.json().errors[0].code]).toEqual([404, "SECRET_NOT_FOUND"]);
    // A value outside { data } is not read.
    expect((await app.inject({ method: "PUT", url: `/admin/api/secrets/${PREFIX}-gone`, headers: { authorization: `Bearer ${adminToken}` }, payload: { value: "x" } })).statusCode).toBe(400);
  });

  it("saves an auth provider with a reference to its client secret, never the secret", async () => {
    await call("PUT", `/admin/api/secrets/${PREFIX}-client`, { value: PLAINTEXT });
    const created = await call("POST", "/admin/api/auth-providers", {
      type: "OIDC",
      name: "Admin secrets test OIDC",
      configuration: { issuer: "https://idp.example.test", client_id: "abc", client_secret_key: `${PREFIX}-client`, allowed_redirect_urls: ["https://app.example.test/cb"] },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.configuration.client_secret_key).toBe(`${PREFIX}-client`);
    const listed = await call("GET", "/admin/api/auth-providers");
    expect(listed.body).not.toContain(PLAINTEXT);

    const id = created.json().data.id as string;
    const redirect = (await call("GET", `/admin/api/auth-providers/${id}/redirect-uri`)).json().data;
    expect(Object.keys(redirect).sort()).toEqual(["redirectUri", "slug"]);
    const removed = await call("DELETE", `/admin/api/auth-providers/${id}`);
    expect([removed.statusCode, removed.body]).toEqual([204, ""]);
    const again = await call("DELETE", `/admin/api/auth-providers/${id}`);
    expect([again.statusCode, again.json().errors[0].code]).toEqual([404, "AUTH_PROVIDER_NOT_FOUND"]);
  });

  it("refuses a provider that can never work: no redirect URL, no issuer, a missing secret", async () => {
    const base = { type: "OIDC", name: "Admin secrets test bad" };
    const good = { issuer: "https://idp.example.test", client_id: "abc", client_secret_key: `${PREFIX}-client`, allowed_redirect_urls: ["https://app.example.test/cb"] };
    for (const configuration of [
      { ...good, allowed_redirect_urls: [] },
      { ...good, issuer: "" },
      { ...good, client_secret_key: `${PREFIX}-does-not-exist` },
    ]) {
      const res = await call("POST", "/admin/api/auth-providers", { ...base, configuration });
      expect(res.statusCode, JSON.stringify(configuration)).toBe(400);
      expect(res.json().errors[0].code).toBe("INVALID_AUTH_PROVIDER_PAYLOAD");
    }
  });
});
