import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAdminUi } from "./admin-ui.js";
import type { AppContext } from "./context.js";
import { adminToken as loginAdmin, cleanupTracked, setupTestApp, track, uniqueSuffix } from "./test-support.js";

const SUFFIX = uniqueSuffix();

/** Security.md §2.18: the session cookie, its CSRF rule, and the security headers (Foundations.md §4.7). */
describe("session cookie", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let foreign: string;
  let own: string;
  const PASSWORD = "session-cookie-test-password";
  const EMAIL = `session-cookie-test-${SUFFIX}@example.com`;

  const SAME_SITE = { "sec-fetch-site": "same-origin" };

  function portalLogin(headers: Record<string, string>, body: Record<string, unknown> = { mode: "session" }) {
    return app.inject({ method: "POST", url: "/admin/api/auth/login", headers, payload: { email: EMAIL, password: PASSWORD, ...body } });
  }

  /** The cookie a response set, as a browser would send it back. */
  function cookieOf(response: { headers: Record<string, unknown> }): string {
    const setCookie = String(response.headers["set-cookie"] ?? "");
    return setCookie.split(";")[0]!;
  }

  async function sessionCount(): Promise<number> {
    const { rows } = await database.query(
      `SELECT 1 FROM totalbase.sessions s JOIN totalbase.users u ON u.id = s."user" WHERE u.email = $1 AND s.revoked_at IS NULL`,
      [EMAIL],
    );
    return rows.length;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = await loginAdmin(context);
    own = new URL(await context.auth.mailer.publicUrl()).origin;
    foreign = "https://another-site.example.com";
    const roleId = track("roles", (await context.roles.create(`session-cookie-test-${SUFFIX}`)).id);
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { email: EMAIL, name: "Cookie", password: PASSWORD, roleIds: [roleId] } },
    });
    expect(created.statusCode).toBe(201);
    track("users", created.json().data.id as string);
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await app.close();
  });

  it("mode session sets an HttpOnly cookie, returns no token, and the cookie authenticates", async () => {
    const login = await portalLogin(SAME_SITE);
    expect(login.statusCode).toBe(200);
    expect(login.json().data.token).toBeNull();
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toMatch(/tb_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);

    const me = await app.inject({ method: "GET", url: "/admin/api/auth/me", headers: { cookie: cookieOf(login) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.email).toBe(EMAIL);
  });

  it("the default stays json: the token in the body, no cookie", async () => {
    const login = await portalLogin(SAME_SITE, {});
    expect(login.statusCode).toBe(200);
    expect(typeof login.json().data.token).toBe("string");
    expect(login.headers["set-cookie"]).toBeUndefined();
    await app.inject({ method: "POST", url: "/admin/api/auth/logout", headers: { authorization: `Bearer ${login.json().data.token}` } });
  });

  it("refuses an unknown mode", async () => {
    const login = await portalLogin(SAME_SITE, { mode: "jwt" });
    expect([login.statusCode, login.json().errors[0].code]).toEqual([400, "INVALID_FIELD"]);
  });

  it("refuses a cookie sign-in from another site before any session exists (login CSRF)", async () => {
    const before = await sessionCount();
    const login = await portalLogin({ origin: foreign, "sec-fetch-site": "cross-site" });
    expect([login.statusCode, login.json().errors[0].code]).toEqual([403, "CROSS_SITE_REQUEST_REFUSED"]);
    expect(login.headers["set-cookie"]).toBeUndefined();
    expect(await sessionCount()).toBe(before);
    // The public URL's own origin is accepted without Sec-Fetch-Site.
    const fromOwn = await portalLogin({ origin: own });
    expect(fromOwn.statusCode).toBe(200);
  });

  it("holds a cookie-authenticated write to the same origin; a bearer token is not held", async () => {
    const cookie = cookieOf(await portalLogin(SAME_SITE));
    const rename = (headers: Record<string, string>, name: string) =>
      app.inject({ method: "PATCH", url: "/app/api/me", headers, payload: { data: { name } } });

    const crossSite = await rename({ cookie, origin: foreign, "sec-fetch-site": "cross-site" }, "Attacker");
    expect([crossSite.statusCode, crossSite.json().errors[0].code]).toEqual([403, "CROSS_SITE_REQUEST_REFUSED"]);
    const noOrigin = await rename({ cookie }, "Attacker");
    expect(noOrigin.statusCode).toBe(403);
    expect((await rename({ cookie, ...SAME_SITE }, "Cookie renamed")).statusCode).toBe(200);
    expect((await rename({ cookie, origin: own }, "Cookie again")).statusCode).toBe(200);
    // A public route isn't authenticated by the cookie: a json sign-in carrying one isn't held.
    const signIn = await app.inject({ method: "POST", url: "/api/auth/login", headers: { cookie, origin: foreign }, payload: { email: EMAIL, password: PASSWORD } });
    expect(signIn.statusCode).not.toBe(403);
    // Reads are never held: a GET changes nothing.
    expect((await app.inject({ method: "GET", url: "/app/api/me", headers: { cookie, origin: foreign } })).statusCode).toBe(200);

    // A header wins over the cookie, and a token is never sent by itself: no origin rule.
    const json = await portalLogin(SAME_SITE, {});
    const token = json.json().data.token as string;
    expect((await rename({ authorization: `Bearer ${token}`, cookie, origin: foreign }, "Cookie by token")).statusCode).not.toBe(403);
  });

  it("sign-out revokes the session and removes the cookie", async () => {
    const cookie = cookieOf(await portalLogin(SAME_SITE));
    const logout = await app.inject({ method: "POST", url: "/admin/api/auth/logout", headers: { cookie, ...SAME_SITE } });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toMatch(/tb_session=; .*Max-Age=0/);
    expect((await app.inject({ method: "GET", url: "/admin/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("every answer carries the security headers; a JSON API answer is never cached", async () => {
    const me = await app.inject({ method: "GET", url: "/admin/api/auth/me", headers: { authorization: `Bearer ${adminToken}` } });
    expect(me.headers["x-content-type-options"]).toBe("nosniff");
    expect(me.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(me.headers["cache-control"]).toBe("no-store");
    const refused = await app.inject({ method: "GET", url: "/admin/api/auth/me" });
    expect(refused.headers["cache-control"]).toBe("no-store");
  });
});

describe("the UI's Content-Security-Policy", () => {
  let dir: string;
  const INLINE = "window.__test__=1";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "totalbase-csp-"));
    writeFileSync(
      join(dir, "index.html"),
      `<html><head><script type="module" src="/_nuxt/app.js"></script><script>${INLINE}</script>` +
        `<script type="application/json" id="__NUXT_DATA__">[1]</script></head><body></body></html>`,
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the build's inline scripts by hash, never any inline script", async () => {
    const app = Fastify();
    await registerAdminUi(app, true, dir);
    const page = await app.inject({ method: "GET", url: "/some/page" });
    const csp = String(page.headers["content-security-policy"]);
    const hash = createHash("sha256").update(INLINE).digest("base64");
    expect(csp).toContain(`script-src 'self' 'unsafe-eval' 'sha256-${hash}'`);
    expect(csp).not.toContain("'unsafe-inline' 'unsafe-eval'");
    expect(csp.match(/'sha256-/g)).toHaveLength(1);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    await app.close();
  });
});
