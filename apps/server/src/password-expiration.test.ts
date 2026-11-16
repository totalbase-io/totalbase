import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { totpCode, totpStep } from "@totalbase/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken, setupTestApp, uniqueSuffix, waitFor } from "./test-support.js";

/**
 * Password expiration (Security.md §2.20): PostgreSQL dates a password, auth.password_max_age_days ages it, an
 * administrator may ask for a new one - and a sign-in with a password that is due changes it in place, on both
 * surfaces, in its order with the second factor.
 */
describe("Password expiration (integration)", () => {
  const PASSWORD = "a-strong-enough-password";
  const RENEWED = "another-strong-enough-password";
  // The widest age the setting takes: no other account of the test database is that old, so the tests running
  // beside this one never meet an expired password of their own.
  const MAX_AGE_DAYS = 3650;
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let admin: string;
  let roleId: string;
  const emails: string[] = [];

  let requests = 0;
  /** Each request from its own address, so the per-IP rate limit never answers first. */
  const call = (method: string, url: string, body?: unknown, token?: string) =>
    app.inject({
      method: method as "POST",
      url,
      remoteAddress: `10.8.${(requests >> 8) & 255}.${requests++ & 255}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const error = (response: { statusCode: number; json: () => { errors: { code: string; meta?: Record<string, unknown> }[] } }) =>
    [response.statusCode, response.json().errors[0]!.code];

  /** A portal user with API and app access. */
  async function person(): Promise<{ email: string; id: string }> {
    const email = `pwd-${uniqueSuffix()}@example.com`;
    emails.push(email);
    const created = await call("POST", "/admin/api/users", { data: { email, name: "Password", password: PASSWORD, roleIds: [roleId] } }, admin);
    expect(created.statusCode, created.body).toBe(201);
    return { email, id: created.json().data.id };
  }

  /**
   * Makes the password as old as time would: the trigger keeps password_changed_at against every write, so it
   * steps aside inside one transaction - the table stays locked until it is back.
   */
  async function age(userId: string, days = MAX_AGE_DAYS + 1): Promise<void> {
    await database.transaction(async (client) => {
      await client.query(`ALTER TABLE totalbase.users DISABLE TRIGGER users_password_changed_at`);
      await client.query(`UPDATE totalbase.users SET password_changed_at = now() - make_interval(days => $2::int) WHERE id = $1`, [userId, days]);
      await client.query(`ALTER TABLE totalbase.users ENABLE TRIGGER users_password_changed_at`);
    });
  }

  const column = async <T>(userId: string, name: "password_changed_at" | "password_change_required"): Promise<T> =>
    (await database.query<Record<string, T>>(`SELECT ${name} FROM totalbase.users WHERE id = $1`, [userId])).rows[0]![name]!;

  /** A sign-in answered with the password step; returns its challenge. */
  async function dueSignIn(url: string, email: string, password = PASSWORD, reason = "EXPIRED"): Promise<string> {
    const login = await call("POST", url, { email, password });
    expect(error(login), login.body).toEqual([403, "PASSWORD_CHANGE_REQUIRED"]);
    expect(login.json().data).toBeUndefined();
    const { challenge, expiresAt, reason: why } = login.json().errors[0].meta;
    expect(why).toBe(reason);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    return challenge;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    admin = await adminToken(context);
    roleId = (await context.roles.create(`pwd-test-${uniqueSuffix()}`, { appAccess: true, apiAccess: true })).id;
    await context.settings.set("auth.password_max_age_days", MAX_AGE_DAYS);
  });

  afterAll(async () => {
    await context.settings.reset("auth.password_max_age_days");
    await context.settings.reset("auth.mfa_required");
    await database.query(`DELETE FROM totalbase.users WHERE email = ANY($1)`, [emails]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
    await database.close();
  });

  it("PostgreSQL dates the password: set with it, kept against a write, moved by a change, gone with it", async () => {
    const who = await person();
    const set = await column<Date>(who.id, "password_changed_at");
    expect(Date.now() - set.getTime()).toBeLessThan(60_000);
    // No write sets it - not the table's owner, not an administrator through the Data API.
    await database.query(`UPDATE totalbase.users SET password_changed_at = '2001-01-01', name = 'Renamed' WHERE id = $1`, [who.id]);
    expect((await column<Date>(who.id, "password_changed_at")).getTime()).toBe(set.getTime());
    const patched = await call("PATCH", `/api/totalbase/table/users/${who.id}`, { data: { password_changed_at: "2001-01-01T00:00:00Z" } }, admin);
    expect(patched.statusCode, patched.body).toBeLessThan(500);
    expect((await column<Date>(who.id, "password_changed_at")).getTime()).toBe(set.getTime());

    await age(who.id, 30);
    await database.query(`UPDATE totalbase.users SET password_change_required = true WHERE id = $1`, [who.id]);
    const changed = await call("PUT", `/admin/api/users/${who.id}/password`, { data: { password: RENEWED } }, admin);
    expect(changed.statusCode, changed.body).toBe(204);
    expect(Date.now() - (await column<Date>(who.id, "password_changed_at")).getTime()).toBeLessThan(60_000);
    // A new password answers the request to change it.
    expect(await column<boolean>(who.id, "password_change_required")).toBe(false);

    // Without a password there is nothing to date, or to ask for.
    await database.query(`UPDATE totalbase.users SET password_hash = NULL, password_change_required = true WHERE id = $1`, [who.id]);
    expect(await column<Date | null>(who.id, "password_changed_at")).toBeNull();
    expect(await column<boolean>(who.id, "password_change_required")).toBe(false);
  });

  it("an expired password gets a challenge instead of a session, and is changed in place", async () => {
    const who = await person();
    const before = await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD });
    expect(before.statusCode, before.body).toBe(200);
    const oldSession = before.json().data.token;
    await age(who.id);

    const challenge = await dueSignIn("/admin/api/auth/login", who.email);
    // A refused password leaves the challenge usable: the one it already has, a weak one, none.
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: PASSWORD }))).toEqual([400, "PASSWORD_UNCHANGED"]);
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: "short" }))).toEqual([400, "PASSWORD_TOO_SHORT"]);
    expect((await call("POST", "/admin/api/auth/password/renew", { challenge })).statusCode).toBe(400);

    const renewed = await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: RENEWED });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json().data.admin.email).toBe(who.email);
    const session = renewed.json().data.token;
    expect((await call("GET", "/app/api/me", undefined, session)).statusCode).toBe(200);
    // A change's aftermath: the sessions it had are gone.
    expect((await call("GET", "/app/api/me", undefined, oldSession)).statusCode).toBe(401);

    // Single-use; the old password is gone, the new one signs in at once.
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: "yet-another-strong-password" }))).toEqual([401, "INVALID_PASSWORD_CHALLENGE"]);
    expect((await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).statusCode).toBe(401);
    expect((await call("POST", "/admin/api/auth/login", { email: who.email, password: RENEWED })).statusCode).toBe(200);
  });

  it("tells nothing to someone without the password", async () => {
    const who = await person();
    await age(who.id);
    expect(error(await call("POST", "/admin/api/auth/login", { email: who.email, password: "not-the-password-at-all" }))).toEqual([401, "AUTHENTICATION_REQUIRED"]);
  });

  it("the Data API sign-in takes the same step, and a challenge only continues on its own surface", async () => {
    const who = await person();
    await age(who.id);
    const challenge = await dueSignIn("/api/auth/login", who.email);
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: RENEWED }))).toEqual([401, "INVALID_PASSWORD_CHALLENGE"]);
    // Nor is it a second factor's challenge.
    expect(error(await call("POST", "/api/auth/mfa/verify", { challenge, code: "123456" }))).toEqual([401, "INVALID_MFA_CHALLENGE"]);
    const renewed = await call("POST", "/api/auth/password/renew", { challenge, newPassword: RENEWED });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json().data.user.email).toBe(who.email);
    expect((await call("GET", "/api/auth/me", undefined, renewed.json().data.token)).statusCode).toBe(200);
  });

  it("reads the setting live: off, an old password signs in; on again, it is due again", async () => {
    const who = await person();
    await age(who.id);
    await context.settings.set("auth.password_max_age_days", 0);
    try {
      const login = await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD });
      expect(login.statusCode, login.body).toBe(200);
      const me = (await call("GET", "/app/api/me", undefined, login.json().data.token)).json().data;
      expect(me.passwordExpiresAt).toBeNull();
      expect(typeof me.passwordChangedAt).toBe("string");
    } finally {
      await context.settings.set("auth.password_max_age_days", MAX_AGE_DAYS);
    }
    await dueSignIn("/admin/api/auth/login", who.email);
  });

  it("My account says when the password expires", async () => {
    const who = await person();
    const login = await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD });
    const me = (await call("GET", "/app/api/me", undefined, login.json().data.token)).json().data;
    const days = (new Date(me.passwordExpiresAt).getTime() - new Date(me.passwordChangedAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(MAX_AGE_DAYS);
    const user = (await call("GET", `/admin/api/users/${who.id}`, undefined, admin)).json().data;
    expect(user.passwordChangedAt).toBe(me.passwordChangedAt);
    expect(user.passwordChangeRequired).toBe(false);
  });

  it("an administrator's temporary password is changed at the next sign-in, whatever the setting", async () => {
    const who = await person();
    await context.settings.set("auth.password_max_age_days", 0);
    try {
      const set = await call("PUT", `/admin/api/users/${who.id}/password`, { data: { password: RENEWED, mustChange: true } }, admin);
      expect(set.statusCode, set.body).toBe(204);
      expect((await call("GET", `/admin/api/users/${who.id}`, undefined, admin)).json().data.passwordChangeRequired).toBe(true);
      const challenge = await dueSignIn("/admin/api/auth/login", who.email, RENEWED, "REQUESTED");
      const renewed = await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: PASSWORD });
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(await column<boolean>(who.id, "password_change_required")).toBe(false);

      // The request alone, for a password already set: an administrator's write of the row.
      const asked = await call("PATCH", `/api/totalbase/table/users/${who.id}`, { data: { password_change_required: true } }, admin);
      expect(asked.statusCode, asked.body).toBe(200);
      await dueSignIn("/admin/api/auth/login", who.email, PASSWORD, "REQUESTED");
    } finally {
      await context.settings.set("auth.password_max_age_days", MAX_AGE_DAYS);
    }
  });

  it("a change never takes the password the account already has", async () => {
    const who = await person();
    const session = (await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).json().data.token;
    expect(error(await call("PUT", "/app/api/me/password", { data: { currentPassword: PASSWORD, password: PASSWORD } }, session))).toEqual([400, "PASSWORD_UNCHANGED"]);
    const api = (await call("POST", "/api/auth/login", { email: who.email, password: PASSWORD })).json().data.token;
    expect(error(await call("POST", "/api/auth/password/change", { currentPassword: PASSWORD, newPassword: PASSWORD }, api))).toEqual([400, "PASSWORD_UNCHANGED"]);

    // A reset link too - and the refusal doesn't spend it.
    const link = await call("POST", `/admin/api/users/${who.id}/reset-password`, { data: { delivery: "link" } }, admin);
    expect(link.statusCode, link.body).toBe(200);
    const token = new URL(link.json().data.actionUrl).searchParams.get("token");
    expect(error(await call("POST", "/api/auth/password/reset", { token, password: PASSWORD }))).toEqual([400, "PASSWORD_UNCHANGED"]);
    const reset = await call("POST", "/api/auth/password/reset", { token, password: RENEWED });
    expect(reset.statusCode, reset.body).toBeLessThan(300);
    expect((await call("POST", "/admin/api/auth/login", { email: who.email, password: RENEWED })).statusCode).toBe(200);
  });

  it("a challenge ends with its account's way in", async () => {
    const who = await person();
    await age(who.id);
    const challenge = await dueSignIn("/admin/api/auth/login", who.email);
    await database.query(`UPDATE totalbase.users SET active = false WHERE id = $1`, [who.id]);
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: RENEWED }))).toEqual([401, "INVALID_PASSWORD_CHALLENGE"]);
    // Spent: back on, the same challenge is still refused.
    await database.query(`UPDATE totalbase.users SET active = true WHERE id = $1`, [who.id]);
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: RENEWED }))).toEqual([401, "INVALID_PASSWORD_CHALLENGE"]);

    // Access lost since the password: no change, the generic refusal.
    const again = await dueSignIn("/admin/api/auth/login", who.email);
    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1`, [who.id]);
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge: again, newPassword: RENEWED }))).toEqual([401, "AUTHENTICATION_REQUIRED"]);
    expect(Date.now() - (await column<Date>(who.id, "password_changed_at")).getTime()).toBeGreaterThan(86_400_000);
  });

  it("with a second factor: the code first, then the new password - and the code alone opens nothing", async () => {
    const who = await person();
    const session = (await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).json().data.token;
    const { secret } = (await call("POST", "/app/api/me/mfa", { data: { currentPassword: PASSWORD } }, session)).json().data;
    const code = async () => {
      await database.query(`UPDATE totalbase.factors SET last_used_step = NULL WHERE "user" = $1`, [who.id]);
      return totpCode(secret, totpStep());
    };
    expect((await call("POST", "/app/api/me/mfa/confirm", { data: { code: await code() } }, session)).statusCode).toBe(200);
    await age(who.id);

    const login = await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD });
    expect(error(login)).toEqual([403, "MFA_REQUIRED"]);
    const verified = await call("POST", "/admin/api/auth/mfa/verify", { challenge: login.json().errors[0].meta.challenge, code: await code() });
    expect(error(verified), verified.body).toEqual([403, "PASSWORD_CHANGE_REQUIRED"]);
    const { challenge } = verified.json().errors[0].meta;
    // The password step's challenge is not a second factor's: a good code doesn't turn it into a session.
    expect(error(await call("POST", "/admin/api/auth/mfa/verify", { challenge, code: await code() }))).toEqual([401, "INVALID_MFA_CHALLENGE"]);

    const renewed = await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: RENEWED });
    expect(renewed.statusCode, renewed.body).toBe(200);
    const { rows } = await database.query<{ mfa_verified_at: Date | null }>(
      `SELECT mfa_verified_at FROM totalbase.sessions WHERE "user" = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [who.id],
    );
    expect(rows[0]!.mfa_verified_at).not.toBeNull();

    // A provider's sign-in never presented the password: its second step ends in a session, however old that is.
    await age(who.id);
    const provider = await context.auth.mfa.secondStep(who.id, "PORTAL");
    const signedIn = await call("POST", "/admin/api/auth/mfa/verify", { challenge: provider!.challenge, code: await code() });
    expect(signedIn.statusCode, signedIn.body).toBe(200);

    // A challenge issued before the factor existed can't skip it.
    await age(who.id);
    await database.query(`UPDATE totalbase.challenges SET mfa_verified = false, used_at = NULL, expires_at = now() + interval '5 minutes' WHERE "user" = $1 AND purpose = 'PASSWORD'`, [who.id]);
    expect(error(await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: PASSWORD }))).toEqual([401, "INVALID_PASSWORD_CHALLENGE"]);
  });

  it("a required second factor not set up yet comes after the new password", async () => {
    const who = await person();
    await age(who.id);
    await context.settings.set("auth.mfa_required", "EVERYONE");
    try {
      const challenge = await dueSignIn("/admin/api/auth/login", who.email);
      const renewed = await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: RENEWED });
      expect(error(renewed), renewed.body).toEqual([403, "MFA_ENROLLMENT_REQUIRED"]);
      const enroll = renewed.json().errors[0].meta.challenge;
      const enrolled = await call("POST", "/api/auth/mfa/enroll", { challenge: enroll });
      expect(enrolled.statusCode, enrolled.body).toBe(200);
      const verified = await call("POST", "/admin/api/auth/mfa/verify", { challenge: enroll, code: totpCode(enrolled.json().data.secret, totpStep()) });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json().data.recoveryCodes).toHaveLength(10);
      // The password did change at its step.
      const row = await waitFor(async () => (await database.query<{ status: string; metadata: Record<string, unknown> }>(
        `SELECT status, metadata FROM totalbase.logs WHERE principal = $1 AND metadata->>'event' = 'auth.mfa_challenge' AND metadata->>'password_renewed' = 'true' LIMIT 1`,
        [who.id],
      )).rows[0]);
      expect(row).toMatchObject({ status: "EXECUTED", metadata: { mfa: "ENROLL" } });
    } finally {
      await context.settings.reset("auth.mfa_required");
    }
  });

  it("audits the step: the challenge executed with its reason, the change as a sign-in, the password redacted", async () => {
    const who = await person();
    await age(who.id);
    const challenge = await dueSignIn("/admin/api/auth/login", who.email);
    const logged = (event: string) => waitFor(async () => (await database.query<{ status: string; metadata: Record<string, unknown>; body: string }>(
      `SELECT status, metadata, to_jsonb(l)::text AS body FROM totalbase.logs l WHERE principal = $1 AND metadata->>'event' = $2 ORDER BY created_at DESC LIMIT 1`,
      [who.id, event],
    )).rows[0]);
    expect(await logged("auth.password_challenge")).toMatchObject({ status: "EXECUTED", metadata: { password: "EXPIRED" } });
    expect((await call("POST", "/admin/api/auth/password/renew", { challenge, newPassword: RENEWED })).statusCode).toBe(200);
    const row = await logged("auth.portal_password_renew");
    expect(row.status).toBe("EXECUTED");
    expect(row.body).not.toContain(RENEWED);
    expect(row.body).not.toContain(challenge);
  });
});
