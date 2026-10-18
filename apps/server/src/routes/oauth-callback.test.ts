import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp, waitFor } from "../test-support.js";

const PREFIX = "oauth-callback-test";
const PROVIDER_NAME = "OAuth Callback Test";
const SLUG = "oauth-callback-test";
const CLIENT_ID = "totalbase-test-client";
const REDIRECT = "https://app.example.test/after-login";

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/**
 * A local OpenID provider: discovery, JWKS and a token endpoint that
 * returns whatever id_token claims the test queued for the next exchange -
 * signed RS256 with node:crypto, verified by TotalBase exactly like a real
 * provider's.
 */
class FakeOidcProvider {
  private server!: Server;
  private readonly privateKey: KeyObject;
  private readonly publicJwk: Record<string, unknown>;
  issuer = "";
  nextClaims: Record<string, unknown> = {};

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const json = (body: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.url === "/.well-known/openid-configuration") {
        return json({ issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
      }
      if (request.url === "/jwks") return json({ keys: [this.publicJwk] });
      if (request.url === "/token" && request.method === "POST") {
        request.resume();
        return request.on("end", () => json({ access_token: "access", token_type: "Bearer", id_token: this.idToken(this.nextClaims) }));
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private idToken(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
    const payload = base64url(JSON.stringify({ iss: this.issuer, aud: CLIENT_ID, iat: now, exp: now + 300, ...claims }));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), this.privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
  }
}

/**
 * GET /api/auth/oauth/:provider/callback against a real (local) OIDC
 * provider. Includes the permanent regression for an account that can't
 * sign in - the Workflows system user, a deactivated user - being reached
 * through a provider that asserts its email (AGENTS.md section 23).
 */
describe("OAuth/OIDC callback", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const provider = new FakeOidcProvider();
  let roleId: string;

  /** Runs the whole redirect dance for one identity and returns where the browser ends up. */
  async function signIn(claims: Record<string, unknown>, redirect = REDIRECT): Promise<URL> {
    const authorizeUrl = new URL(await context.oauth.start(SLUG, redirect));
    provider.nextClaims = { nonce: authorizeUrl.searchParams.get("nonce"), ...claims };
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oauth/${SLUG}/callback?code=test-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state")!)}`,
    });
    expect(res.statusCode, res.body).toBe(302);
    return new URL(res.headers.location as string);
  }
  const fragment = (url: URL) => new URLSearchParams(url.hash.slice(1));
  const sessionsOf = async (userId: string) =>
    (await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM totalbase.sessions WHERE "user" = $1`, [userId])).rows[0]!.count;
  const identitiesOf = async (userId: string) =>
    (await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM totalbase.identities WHERE "user" = $1`, [userId])).rows[0]!.count;

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.providers WHERE name = $1`, [PROVIDER_NAME]);
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.secrets WHERE key = $1`, [`${PREFIX}-client-secret`]).catch(() => undefined);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await provider.start();
    await cleanup();
    roleId = (await context.roles.create(`${PREFIX}-api`, { apiAccess: true })).id;
    await context.secrets.set(`${PREFIX}-client-secret`, "shh");
    await context.authProviders.create({
      type: "OIDC",
      name: PROVIDER_NAME,
      configuration: {
        issuer: provider.issuer,
        client_id: CLIENT_ID,
        client_secret_key: `${PREFIX}-client-secret`,
        allowed_redirect_urls: [REDIRECT],
        default_role_id: roleId,
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await provider.stop();
    await app.close();
  });

  it("creates the account on a first sign-in and hands the caller a working session", async () => {
    const landing = await signIn({ sub: randomUUID(), email: `${PREFIX}-new@example.com`, email_verified: true, name: "New Person" });
    expect(landing.origin + landing.pathname).toBe(REDIRECT);
    const token = fragment(landing).get("token");
    expect(token).toBeTruthy();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data).toMatchObject({ email: `${PREFIX}-new@example.com`, name: "New Person" });
  });

  it("refuses the Workflows system account - no session, no link (regression)", async () => {
    const systemId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [WORKFLOWS_SYSTEM_USER_EMAIL])).rows[0]!.id;
    const sessionsBefore = await sessionsOf(systemId);
    const identitiesBefore = await identitiesOf(systemId);

    const landing = await signIn({ sub: randomUUID(), email: WORKFLOWS_SYSTEM_USER_EMAIL, email_verified: true });
    expect(fragment(landing).get("error")).toBe("access_denied");
    expect(fragment(landing).get("token")).toBeNull();
    expect(await sessionsOf(systemId)).toBe(sessionsBefore);
    expect(await identitiesOf(systemId)).toBe(identitiesBefore);
  });

  it("refuses a deactivated account, by email and through an existing link", async () => {
    const sub = randomUUID();
    const first = await signIn({ sub, email: `${PREFIX}-leaver@example.com`, email_verified: true });
    expect(fragment(first).get("token")).toBeTruthy();
    const userId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [`${PREFIX}-leaver@example.com`])).rows[0]!.id;
    await database.query(`UPDATE totalbase.users SET active = false WHERE id = $1`, [userId]);
    const sessionsBefore = await sessionsOf(userId);

    const linked = await signIn({ sub, email: `${PREFIX}-leaver@example.com`, email_verified: true });
    expect(fragment(linked).get("error")).toBe("access_denied");
    const byEmail = await signIn({ sub: randomUUID(), email: `${PREFIX}-leaver@example.com`, email_verified: true });
    expect(fragment(byEmail).get("error")).toBe("access_denied");
    expect(await sessionsOf(userId)).toBe(sessionsBefore);
  });

  it("refuses a locked-out account, by email and through an existing link - then lets it in once the lock ends (security regression)", async () => {
    const sub = randomUUID();
    const email = `${PREFIX}-locked@example.com`;
    expect(fragment(await signIn({ sub, email, email_verified: true })).get("token")).toBeTruthy();
    const userId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [email])).rows[0]!.id;
    await database.query(`UPDATE totalbase.users SET locked_until = now() + interval '15 minutes' WHERE id = $1`, [userId]);
    const sessionsBefore = await sessionsOf(userId);

    expect(fragment(await signIn({ sub, email, email_verified: true })).get("error")).toBe("access_denied");
    expect(fragment(await signIn({ sub: randomUUID(), email, email_verified: true })).get("error")).toBe("access_denied");
    expect(await sessionsOf(userId)).toBe(sessionsBefore);

    await database.query(`UPDATE totalbase.users SET locked_until = now() - interval '1 minute' WHERE id = $1`, [userId]);
    expect(fragment(await signIn({ sub, email, email_verified: true })).get("token")).toBeTruthy();
  });

  describe("auth.email_verification_required", () => {
    beforeAll(async () => {
      await context.settings.set("auth.email_verification_required", true);
    });
    afterAll(async () => {
      await context.settings.reset("auth.email_verification_required");
    });

    it("refuses an account whose email neither it nor the provider verified - #error=email_not_verified, no session, audited", async () => {
      const sub = randomUUID();
      const email = `${PREFIX}-unverified@example.com`;
      const first = await signIn({ sub, email, email_verified: false });
      expect(fragment(first).get("error")).toBe("email_not_verified");
      expect(fragment(first).get("token")).toBeNull();
      const userId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [email])).rows[0]!.id;
      expect(await sessionsOf(userId)).toBe(0);

      const audit = await waitFor(async () => (await database.query<{ metadata: unknown }>(
        `SELECT metadata FROM totalbase.logs WHERE action = 'AUTH' AND metadata->>'user_id' = $1 AND metadata->>'reason' = 'email_not_verified'`,
        [userId],
      )).rows[0]);
      expect(audit.metadata).toMatchObject({ event: "auth.oauth_login" });

      // Still unverified through the existing link.
      expect(fragment(await signIn({ sub, email, email_verified: false })).get("error")).toBe("email_not_verified");

      // The provider verifying that very address verifies the account.
      expect(fragment(await signIn({ sub, email, email_verified: true })).get("token")).toBeTruthy();
      const { rows } = await database.query<{ verified: boolean }>(`SELECT email_verified_at IS NOT NULL AS verified FROM totalbase.users WHERE id = $1`, [userId]);
      expect(rows[0]!.verified).toBe(true);
    });

    it("refuses an unverified password account through a provider link whose email differs", async () => {
      const email = `${PREFIX}-linked-unverified@example.com`;
      const user = await context.auth.users.create({ email });
      await context.roleAssignments.assignRoleToUser(user.id, roleId);
      const sub = randomUUID();
      const { rows: providerRows } = await database.query<{ id: string }>(`SELECT id FROM totalbase.providers WHERE name = $1`, [PROVIDER_NAME]);
      await database.query(
        `INSERT INTO totalbase.identities ("user", provider, provider_subject, provider_email) VALUES ($1, $2, $3, $4)`,
        [user.id, providerRows[0]!.id, sub, `${PREFIX}-elsewhere@example.com`],
      );
      expect(fragment(await signIn({ sub, email: `${PREFIX}-elsewhere@example.com`, email_verified: true })).get("error")).toBe("email_not_verified");
      expect(await sessionsOf(user.id)).toBe(0);
    });
  });

  it("never lets a session of a can_login = false account authenticate (defense in depth)", async () => {
    const user = await context.auth.users.create({ email: `${PREFIX}-nologin@example.com` });
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    const { token } = await context.auth.sessions.create({ user: user.id, ttlHours: 1, maxSessionsPerUser: 10 });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    await database.query(`UPDATE totalbase.users SET can_login = false WHERE id = $1`, [user.id]);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it("rejects a tampered state", async () => {
    const res = await app.inject({ method: "GET", url: `/api/auth/oauth/${SLUG}/callback?code=x&state=forged.state` });
    expect(res.statusCode).toBe(401);
    expect(res.json().errors[0].code).toBe("INVALID_OAUTH_STATE");
  });

  describe("the portal's sign-in page", () => {
    const providerId = async () => (await context.authProviders.list()).find((p) => p.slug === SLUG)!.id;
    const portalProviders = async () => (await app.inject({ method: "GET", url: "/api/instance" })).json().data.login.providers as Array<{ slug: string }>;

    it("is refused, and not listed, while the provider isn't shown on the sign-in page", async () => {
      const portal = await context.oauth.portalCallbackUrl();
      const res = await app.inject({ method: "GET", url: `/api/auth/oauth/${SLUG}?redirect_to=${encodeURIComponent(portal)}` });
      expect(res.json().errors[0].code).toBe("OAUTH_REDIRECT_NOT_ALLOWED");
      expect((await portalProviders()).map((p) => p.slug)).not.toContain(SLUG);
    });

    it("signs in to the portal with portal access - API access isn't what it asks for", async () => {
      await context.authProviders.update(await providerId(), { showOnSignIn: true });
      try {
        const portal = await context.oauth.portalCallbackUrl();
        expect(await portalProviders()).toContainEqual({ slug: SLUG, name: PROVIDER_NAME, type: "OIDC", signInUrl: `/api/auth/oauth/${SLUG}?redirect_to=${encodeURIComponent(portal)}` });
        const landing = await signIn({ sub: randomUUID(), email: `${PREFIX}-portal@example.com`, email_verified: true, name: "Portal Person" }, portal);
        expect(landing.origin + landing.pathname).toBe(portal);
        const token = fragment(landing).get("token");
        expect((await app.inject({ method: "GET", url: "/app/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

        // A role with API access only: the portal refuses it, as its password sign-in does.
        await database.query(`UPDATE totalbase.roles SET app_access = false WHERE id = $1`, [roleId]);
        const refused = await signIn({ sub: randomUUID(), email: `${PREFIX}-api-only@example.com`, email_verified: true, name: "API Only" }, portal);
        expect(fragment(refused).get("error")).toBe("access_denied");
        const apiOnly = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [`${PREFIX}-api-only@example.com`])).rows[0]!.id;
        const live = await database.query(`SELECT 1 FROM totalbase.sessions WHERE "user" = $1 AND revoked_at IS NULL`, [apiOnly]);
        expect(live.rows).toHaveLength(0);
      } finally {
        await database.query(`UPDATE totalbase.roles SET app_access = true WHERE id = $1`, [roleId]);
        await context.authProviders.update(await providerId(), { showOnSignIn: false });
      }
    });
  });

  it("only starts a sign-in towards an allowlisted redirect", async () => {
    const res = await app.inject({ method: "GET", url: `/api/auth/oauth/${SLUG}?redirect_to=${encodeURIComponent("https://evil.example.test/steal")}` });
    expect(res.json().errors[0].code).toBe("OAUTH_REDIRECT_NOT_ALLOWED");
  });
});
