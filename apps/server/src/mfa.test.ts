import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { totpCode, totpStep } from "@totalbase/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken, setupTestApp, uniqueSuffix, waitFor } from "./test-support.js";

/**
 * Multi-factor authentication (Security.md §2.17): setting it up from My account, the two-step sign-in on both
 * surfaces and through every refusal, recovery codes, the instance's requirement, and the administrator's reset.
 */
describe("Two-factor authentication (integration)", () => {
  const PASSWORD = "a-strong-enough-password";
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
      remoteAddress: `10.9.${(requests >> 8) & 255}.${requests++ & 255}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  /** A portal user with API and app access, signed in; returns its email, id and session. */
  async function person(): Promise<{ email: string; id: string; session: string }> {
    const email = `mfa-${uniqueSuffix()}@example.com`;
    emails.push(email);
    const created = await call("POST", "/admin/api/users", { data: { email, name: "MFA", password: PASSWORD, roleIds: [roleId] } }, admin);
    expect(created.statusCode, created.body).toBe(201);
    const login = await call("POST", "/admin/api/auth/login", { email, password: PASSWORD });
    expect(login.statusCode, login.body).toBe(200);
    return { email, id: created.json().data.id, session: login.json().data.token };
  }

  /** The next code the factor accepts: a step after the last one used (one ahead of now is within the window). */
  async function nextCode(userId: string, secret: string): Promise<string> {
    // The test signs in several times within one 30-second step: forget the last step used, as time passing would.
    await database.query(`UPDATE totalbase.factors SET last_used_step = NULL WHERE "user" = $1`, [userId]);
    return totpCode(secret, totpStep());
  }

  /** Sets it up from My account and returns the secret and the recovery codes. */
  async function enable(who: { id: string; session: string }): Promise<{ secret: string; recoveryCodes: string[] }> {
    const started = await call("POST", "/app/api/me/mfa", { data: { currentPassword: PASSWORD } }, who.session);
    expect(started.statusCode, started.body).toBe(201);
    const { secret, otpauthUrl } = started.json().data;
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const confirmed = await call("POST", "/app/api/me/mfa/confirm", { data: { code: await nextCode(who.id, secret) } }, who.session);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return { secret, recoveryCodes: confirmed.json().data.recoveryCodes };
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    admin = await adminToken(context);
    roleId = (await context.roles.create(`mfa-test-${uniqueSuffix()}`, { appAccess: true, apiAccess: true })).id;
  });

  afterAll(async () => {
    await context.settings.reset("auth.mfa_required");
    await database.query(`DELETE FROM totalbase.users WHERE email = ANY($1)`, [emails]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
    await database.close();
  });

  it("sets it up from My account: the secret is stored encrypted, and the first code confirms it", async () => {
    const who = await person();
    const { secret, recoveryCodes } = await enable(who);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    const { rows } = await database.query<{ secret: string; confirmed_at: Date | null }>(`SELECT secret, confirmed_at FROM totalbase.factors WHERE "user" = $1`, [who.id]);
    expect(rows[0]!.confirmed_at).not.toBeNull();
    expect(rows[0]!.secret).not.toContain(secret);
    const me = (await call("GET", "/app/api/me", undefined, who.session)).json().data;
    expect(me.mfa).toMatchObject({ enabled: true, recoveryCodesLeft: 10, required: false });
    // Once on, starting again is refused until it's turned off.
    expect((await call("POST", "/app/api/me/mfa", { data: { currentPassword: PASSWORD } }, who.session)).json().errors[0].code).toBe("MFA_ALREADY_ENABLED");
    // The admin's user shows it.
    expect((await call("GET", `/admin/api/users/${who.id}`, undefined, admin)).json().data.mfaEnabled).toBe(true);
  });

  it("a wrong first code doesn't turn it on", async () => {
    const who = await person();
    await call("POST", "/app/api/me/mfa", { data: { currentPassword: PASSWORD } }, who.session);
    const wrong = await call("POST", "/app/api/me/mfa/confirm", { data: { code: "000000" } }, who.session);
    expect([wrong.statusCode, wrong.json().errors[0].code]).toEqual([401, "INVALID_MFA_CODE"]);
    expect((await call("GET", "/app/api/me", undefined, who.session)).json().data.mfa.enabled).toBe(false);
    // And a sign-in still gets its session at once.
    expect((await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).statusCode).toBe(200);
  });

  it("signs in to the portal in two steps: the password gets a challenge, not a session", async () => {
    const who = await person();
    const { secret } = await enable(who);

    const login = await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD });
    expect([login.statusCode, login.json().errors[0].code]).toEqual([403, "MFA_REQUIRED"]);
    const { challenge, expiresAt } = login.json().errors[0].meta;
    expect(typeof challenge).toBe("string");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(login.json().data).toBeUndefined();

    // A wrong code counts toward the lockout.
    const wrong = await call("POST", "/admin/api/auth/mfa/verify", { challenge, code: "000000" });
    expect([wrong.statusCode, wrong.json().errors[0].code]).toEqual([401, "INVALID_MFA_CODE"]);
    expect((await database.query<{ n: number }>(`SELECT failed_login_count AS n FROM totalbase.users WHERE id = $1`, [who.id])).rows[0]!.n).toBe(1);

    const code = await nextCode(who.id, secret);
    const verified = await call("POST", "/admin/api/auth/mfa/verify", { challenge, code });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data).toMatchObject({ admin: { id: who.id, access: "APP" }, recoveryCodes: null });
    const token = verified.json().data.token;
    const { rows } = await database.query<{ mfa_verified_at: Date | null }>(
      `SELECT mfa_verified_at FROM totalbase.sessions WHERE "user" = $1 ORDER BY created_at DESC LIMIT 1`,
      [who.id],
    );
    expect(rows[0]!.mfa_verified_at).not.toBeNull();
    expect((await call("GET", "/admin/api/auth/me", undefined, token)).statusCode).toBe(200);
    // A successful sign-in clears the count.
    expect((await database.query<{ n: number }>(`SELECT failed_login_count AS n FROM totalbase.users WHERE id = $1`, [who.id])).rows[0]!.n).toBe(0);

    // The challenge is single-use, and the code good once.
    expect((await call("POST", "/admin/api/auth/mfa/verify", { challenge, code })).json().errors[0].code).toBe("INVALID_MFA_CHALLENGE");
    const again = (await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).json().errors[0].meta.challenge;
    expect((await call("POST", "/admin/api/auth/mfa/verify", { challenge: again, code })).json().errors[0].code).toBe("INVALID_MFA_CODE");
  });

  it("audits the password step as auth.mfa_challenge, executed - not as a refused sign-in", async () => {
    const who = await person();
    await enable(who);
    await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD });
    const row = await waitFor(async () => (await database.query<{ status: string; metadata: Record<string, unknown> }>(
      `SELECT status, metadata FROM totalbase.logs WHERE principal = $1 AND metadata->>'event' = 'auth.mfa_challenge' ORDER BY created_at DESC LIMIT 1`,
      [who.id],
    )).rows[0]);
    expect(row).toMatchObject({ status: "EXECUTED", metadata: { mfa: "VERIFY" } });
  });

  it("the Data API sign-in takes the same second step, and a challenge only continues on its own surface", async () => {
    const who = await person();
    const { secret } = await enable(who);
    const login = await call("POST", "/api/auth/login", { email: who.email, password: PASSWORD });
    expect(login.json().errors[0].code).toBe("MFA_REQUIRED");
    const { challenge } = login.json().errors[0].meta;
    const code = await nextCode(who.id, secret);
    expect((await call("POST", "/admin/api/auth/mfa/verify", { challenge, code })).json().errors[0].code).toBe("INVALID_MFA_CHALLENGE");
    // Refused on the wrong surface, so still open on its own.
    const verified = await call("POST", "/api/auth/mfa/verify", { challenge, code });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data).toMatchObject({ user: { id: who.id }, recoveryCodes: null });
  });

  it("a challenge is spent after five wrong codes", async () => {
    const who = await person();
    const { secret } = await enable(who);
    const challenge = (await call("POST", "/api/auth/login", { email: who.email, password: PASSWORD })).json().errors[0].meta.challenge;
    for (let i = 0; i < 5; i++) await call("POST", "/api/auth/mfa/verify", { challenge, code: "000000" });
    const late = await call("POST", "/api/auth/mfa/verify", { challenge, code: await nextCode(who.id, secret) });
    expect(late.json().errors[0].code).toBe("INVALID_MFA_CHALLENGE");
    // Five wrong codes also reached the lockout (auth.lockout_max_attempts = 5): even the password is refused now.
    expect((await call("POST", "/api/auth/login", { email: who.email, password: PASSWORD })).json().errors[0].code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("a recovery code signs in once", async () => {
    const who = await person();
    const { recoveryCodes } = await enable(who);
    const first = (await call("POST", "/api/auth/login", { email: who.email, password: PASSWORD })).json().errors[0].meta.challenge;
    const used = await call("POST", "/api/auth/mfa/verify", { challenge: first, recoveryCode: recoveryCodes[0]!.toUpperCase() });
    expect(used.statusCode, used.body).toBe(200);
    const second = (await call("POST", "/api/auth/login", { email: who.email, password: PASSWORD })).json().errors[0].meta.challenge;
    expect((await call("POST", "/api/auth/mfa/verify", { challenge: second, recoveryCode: recoveryCodes[0] })).json().errors[0].code).toBe("INVALID_MFA_CODE");
    expect((await call("GET", "/app/api/me", undefined, used.json().data.token)).json().data.mfa.recoveryCodesLeft).toBe(9);
    // Never stored as typed.
    const { rows } = await database.query(`SELECT 1 FROM totalbase.factors_codes WHERE code_hash = $1`, [recoveryCodes[1]]);
    expect(rows).toHaveLength(0);
  });

  it("new recovery codes replace the old ones; turning it off needs the password and a code", async () => {
    const who = await person();
    const { secret, recoveryCodes } = await enable(who);
    const regenerated = await call("POST", "/app/api/me/mfa/recovery-codes", { data: { code: await nextCode(who.id, secret) } }, who.session);
    expect(regenerated.statusCode, regenerated.body).toBe(200);
    expect(regenerated.json().data.recoveryCodes.some((c: string) => recoveryCodes.includes(c))).toBe(false);

    const wrongPassword = await call("POST", "/app/api/me/mfa/disable", { data: { currentPassword: "nope", code: await nextCode(who.id, secret) } }, who.session);
    expect(wrongPassword.json().errors[0].code).toBe("INVALID_CURRENT_PASSWORD");
    const off = await call("POST", "/app/api/me/mfa/disable", { data: { currentPassword: PASSWORD, code: await nextCode(who.id, secret) } }, who.session);
    expect(off.statusCode, off.body).toBe(204);
    expect((await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).statusCode).toBe(200);
  });

  it("an administrator's reset removes it; the user signs in with the password alone", async () => {
    const who = await person();
    await enable(who);
    const reset = await call("DELETE", `/admin/api/users/${who.id}/mfa`, undefined, admin);
    expect(reset.statusCode, reset.body).toBe(204);
    expect((await call("DELETE", `/admin/api/users/${who.id}/mfa`, undefined, admin)).json().errors[0].code).toBe("MFA_NOT_ENABLED");
    expect((await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).statusCode).toBe(200);
    expect((await database.query(`SELECT 1 FROM totalbase.factors_codes c JOIN totalbase.factors f ON f.id = c.factor WHERE f."user" = $1`, [who.id])).rows).toHaveLength(0);
  });

  it("required for everyone: a user without it sets it up while signing in, and can't turn it off", async () => {
    const who = await person();
    await context.settings.set("auth.mfa_required", "EVERYONE");
    try {
      const login = await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD });
      expect([login.statusCode, login.json().errors[0].code]).toEqual([403, "MFA_ENROLLMENT_REQUIRED"]);
      const { challenge } = login.json().errors[0].meta;
      // An enrollment challenge takes no code until the app is set up.
      expect((await call("POST", "/admin/api/auth/mfa/verify", { challenge, code: "123456" })).json().errors[0].code).toBe("INVALID_MFA_CHALLENGE");
      const challenge2 = (await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).json().errors[0].meta.challenge;
      const enrolled = await call("POST", "/api/auth/mfa/enroll", { challenge: challenge2 });
      expect(enrolled.statusCode, enrolled.body).toBe(200);
      const verified = await call("POST", "/admin/api/auth/mfa/verify", { challenge: challenge2, code: await nextCode(who.id, enrolled.json().data.secret) });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json().data.recoveryCodes).toHaveLength(10);
      const session = verified.json().data.token;
      expect((await call("GET", "/app/api/me", undefined, session)).json().data.mfa).toMatchObject({ enabled: true, required: true });
      const off = await call("POST", "/app/api/me/mfa/disable", { data: { currentPassword: PASSWORD, code: await nextCode(who.id, enrolled.json().data.secret) } }, session);
      expect([off.statusCode, off.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);
    } finally {
      await context.settings.reset("auth.mfa_required");
    }
  });

  it("an enrollment challenge only continues while its user's access lasts", async () => {
    const who = await person();
    await context.settings.set("auth.mfa_required", "EVERYONE");
    try {
      const challenge = (await call("POST", "/admin/api/auth/login", { email: who.email, password: PASSWORD })).json().errors[0].meta.challenge;
      const { secret } = (await call("POST", "/api/auth/mfa/enroll", { challenge })).json().data;
      // The role goes before the code is typed: no session.
      await call("PUT", `/admin/api/users/${who.id}/roles`, { data: { roleIds: [] } }, admin);
      const refused = await call("POST", "/admin/api/auth/mfa/verify", { challenge, code: await nextCode(who.id, secret) });
      expect([refused.statusCode, refused.json().errors[0].code]).toEqual([401, "AUTHENTICATION_REQUIRED"]);
    } finally {
      await context.settings.reset("auth.mfa_required");
    }
  });

  it("keeps its tables out of the Data API", async () => {
    for (const table of ["factors", "factors_codes", "challenges"]) {
      const res = await call("GET", `/api/totalbase/table/${table}`, undefined, admin);
      expect(res.statusCode, `${table}: ${res.body}`).toBe(404);
    }
  });
});
