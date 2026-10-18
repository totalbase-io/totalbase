import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { hashPassword } from "@totalbase/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp, waitFor } from "./test-support.js";

const PREFIX = "email-verification-gate-test";
const PASSWORD = "a-strong-enough-password";

/**
 * auth.email_verification_required gates sign-in (Specification_Security.md
 * §2.7): an unverified account can't sign in by any route - a 403
 * EMAIL_NOT_VERIFIED distinct from the generic 401, audited with reason
 * `email_not_verified` - and accounts verified by construction (an
 * administrator's create with a password, an accepted invitation, the
 * bootstrap owner) sign in as before.
 */
describe("Email verification gates sign-in", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let adminToken: string;
  const userIds: string[] = [];

  const login = (url: string, email: string, password = PASSWORD) => app.inject({ method: "POST", url, payload: { email, password } });

  const waitForAudit = (sql: string, params: unknown[]): Promise<Record<string, any>> =>
    waitFor(async () => (await database.query(sql, params)).rows[0]);

  async function unverifiedUser(name: string): Promise<{ id: string; email: string }> {
    const email = `${PREFIX}-${name}@example.com`;
    const user = await context.auth.users.create({ email, passwordHash: await hashPassword(PASSWORD) });
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    userIds.push(user.id);
    return { id: user.id, email };
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    for (const { id } of (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email LIKE '${PREFIX}%'`)).rows) {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    }
    await context.settings.set("auth.email_verification_required", true);
    roleId = (await context.roles.create(`${PREFIX}-role`, { apiAccess: true, appAccess: true })).id;
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await context.settings.reset("auth.email_verification_required");
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
  });

  for (const [route, event] of [["/api/auth/login", "auth.login"], ["/admin/api/auth/login", "auth.portal_login"]] as const) {
    it(`${route}: 403 EMAIL_NOT_VERIFIED after the right password, the generic 401 before it, audited as email_not_verified`, async () => {
      const user = await unverifiedUser(event.replace(".", "-"));

      const wrong = await login(route, user.email, "not-the-password-1");
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().errors[0].code).toBe("AUTHENTICATION_REQUIRED");

      const refused = await login(route, user.email);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().errors[0].code).toBe("EMAIL_NOT_VERIFIED");
      expect(refused.json().data).toBeUndefined();
      const { rows } = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM totalbase.sessions WHERE "user" = $1`, [user.id]);
      expect(rows[0]!.count).toBe(0);

      const audit = await waitForAudit(
        `SELECT * FROM totalbase.logs WHERE action = 'AUTH' AND metadata->>'user_id' = $1 AND metadata->>'reason' = 'email_not_verified'`,
        [user.id],
      );
      expect(audit.status).toBe("DENIED");
      expect(audit.metadata).toMatchObject({ event, reason: "email_not_verified" });

      await context.auth.users.markEmailVerified(user.id);
      expect((await login(route, user.email)).statusCode).toBe(200);
    });
  }

  it("POST /api/auth/email/resend without a session answers 204 for any address, and sends only to an unverified account", async () => {
    const user = await unverifiedUser("resend");
    const before = (await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.emails_tokens WHERE "user" = $1 AND type = 'EMAIL_VERIFICATION'`, [user.id],
    )).rows[0]!.count;

    const unknown = await app.inject({ method: "POST", url: "/api/auth/email/resend", payload: { email: `${PREFIX}-nobody@example.com` } });
    expect(unknown.statusCode).toBe(204);

    const known = await app.inject({ method: "POST", url: "/api/auth/email/resend", payload: { email: user.email } });
    expect(known.statusCode).toBe(204);
    // A link was issued (delivery itself is best-effort, in the background - SMTP may not be configured in the test DB).
    await context.auth.emailsSettled();
    const after = (await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.emails_tokens WHERE "user" = $1 AND type = 'EMAIL_VERIFICATION'`, [user.id],
    )).rows[0]!.count;
    expect(after).toBe(before + 1);

    const missing = await app.inject({ method: "POST", url: "/api/auth/email/resend", payload: {} });
    expect(missing.statusCode).toBe(400);
  });

  it("an administrator's create with a password is verified - it signs in at once", async () => {
    const email = `${PREFIX}-admin-created@example.com`;
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { email, password: PASSWORD, roleIds: [roleId] } },
    });
    expect(res.statusCode, res.body).toBe(201);
    userIds.push(res.json().data.id);
    expect((await login("/admin/api/auth/login", email)).statusCode).toBe(200);
  });

  it("an accepted invitation is verified - it signs in afterwards", async () => {
    const email = `${PREFIX}-invited@example.com`;
    const user = await context.auth.users.create({ email });
    userIds.push(user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    const url = await context.auth.createInvitation({ id: user.id, email, name: null }, "link");
    const token = new URL(url).searchParams.get("token")!;
    const accepted = await app.inject({ method: "POST", url: "/api/auth/invitations/accept", payload: { token, password: PASSWORD } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await login("/api/auth/login", email)).statusCode).toBe(200);
  });

  it("the owner is verified (bootstrap)", async () => {
    const { rows } = await database.query<{ verified: boolean }>(`SELECT email_verified_at IS NOT NULL AS verified FROM totalbase.users WHERE owner`);
    expect(rows).toEqual([{ verified: true }]);
  });
});
