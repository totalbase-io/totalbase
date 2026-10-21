import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";
import { generateUserApiKey } from "@totalbase/users-apis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

type Operation = { security?: unknown[] };
type Spec = { paths: Record<string, Record<string, Operation>> };

const PREFIX = "admin-access-test";
const PASSWORD = "a-strong-enough-password";
// Answer before the guard would be meaningless: these are the
// Admin API's only routes that don't require the Administrators role
// (auth-guards.ts): login is public, logout only ends the token it's
// given, and me tells the portal which surface a caller opens.
const NOT_ADMIN_ONLY = new Set([
  "POST /admin/api/auth/login",
  "POST /admin/api/auth/logout",
  "GET /admin/api/auth/me",
  // A sign-in's second step (Security.md §2.17): public like login - the challenge is the credential.
  "POST /admin/api/auth/mfa/verify",
  // A backup's archive (Administration.md §12.4): followed by the browser, authorized by the signature of a link an
  // administrator was given - never by a session. Without a valid one it names nothing (asserted below).
  "GET /admin/api/backups/{id}/archive",
]);

/**
 * The Admin API is for members of the Administrators role only. Walks
 * every route the server actually registered (the generated Admin
 * OpenAPI document lists each one, documented or not), so a new route
 * added without the guard fails here - a permanent regression test for
 * the Workflows system account reaching Settings through a plane="ADMIN"
 * token.
 */
describe("Admin API access: Administrators only", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let appUserToken: string;
  let systemToken: string;
  let appRoleId: string;
  let systemUserId: string;
  let spec: Spec;

  // Several hundred requests: each from its own address, so the per-IP
  // rate limit (security.rate_limit_per_minute) never answers first.
  let requestCount = 0;
  const inject = (method: string, url: string, token?: string) =>
    app.inject({
      method: method as "GET",
      url,
      remoteAddress: `10.${(requestCount >> 16) & 255}.${(requestCount >> 8) & 255}.${requestCount++ & 255}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }),
    });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${PREFIX}%'`);
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    spec = (await inject("GET", "/admin/api/openapi", adminToken)).json();

    // A person with app access only.
    appRoleId = (await context.roles.create(`${PREFIX}-app`, { appAccess: true })).id;
    const user = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { email: `${PREFIX}-app@example.com`, name: "App only", password: PASSWORD, roleIds: [appRoleId] } },
    });
    expect(user.statusCode, user.body).toBe(201);
    appUserToken = (await context.auth.login({ email: `${PREFIX}-app@example.com`, password: PASSWORD })).token;

    // A plane="ADMIN" token for the Workflows system account, written
    // straight to the table - issuing one is refused now; this stands for
    // one that already existed before that check.
    systemUserId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [WORKFLOWS_SYSTEM_USER_EMAIL])).rows[0]!.id;
    const key = generateUserApiKey();
    await database.query(
      `INSERT INTO totalbase.tokens ("user", name, plane, key_prefix, key_hash, expires_at)
       VALUES ($1, $2, 'ADMIN', $3, $4, now() + interval '1 day')`,
      [systemUserId, `${PREFIX}-system`, key.keyPrefix, key.keyHash],
    );
    systemToken = key.plainKey;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.tokens WHERE name LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [appRoleId]);
    await app.close();
    await database.close();
  });

  it("rejects every admin-only route without a token, for an app user, and for the Workflows system account", async () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const [path, operations] of Object.entries(spec.paths)) {
      // Path parameters get placeholder values: the guard answers before
      // any handler looks at them.
      const url = path.replace(/\{([^}]+)\}/g, (_, name: string) => (/id$/i.test(name) ? "00000000-0000-4000-8000-000000000000" : "x"));
      for (const method of Object.keys(operations).map((m) => m.toUpperCase())) {
        if (NOT_ADMIN_ONLY.has(`${method} ${path}`)) continue;
        checked += 1;
        const cases: Array<[string, string | undefined, number]> = [
          ["no token", undefined, 401],
          ["app user", appUserToken, 403],
          ["Workflows system token", systemToken, 401],
        ];
        for (const [who, token, expected] of cases) {
          const res = await inject(method, url, token);
          if (res.statusCode !== expected) offenders.push(`${method} ${path} (${who}): ${res.statusCode}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
    expect(offenders).toEqual([]);
    // The signed archive route: without its signature, or with a session instead of one, nothing.
    for (const token of [undefined, appUserToken, systemToken, adminToken]) {
      const res = await inject("GET", "/admin/api/backups/00000000-0000-4000-8000-000000000000/archive", token);
      expect(res.statusCode).toBe(404);
    }
  });

  it("refuses to issue any token to a system account", async () => {
    for (const plane of ["ADMIN", "API"]) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/api/tokens",
        remoteAddress: "10.255.0.1",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { data: { userId: systemUserId, name: `${PREFIX}-${plane}`, plane } },
      });
      expect([res.statusCode, res.json().errors?.[0]?.code], plane).toEqual([403, "PERMISSION_DENIED"]);
    }
  });

  it("still lets an Administrator in", async () => {
    expect((await inject("GET", "/admin/api/settings/system", adminToken)).statusCode).toBe(200);
  });
});
