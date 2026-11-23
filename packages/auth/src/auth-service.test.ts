import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "./auth-service.js";
import type { EmailSender } from "./email-sender.js";
import { admitPasswordCheck, hashPassword, PASSWORD_CHECKS_AT_ONCE, PASSWORD_CHECKS_WAITING } from "./password.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
/** Per-run suffix: a stale row from an interrupted run never collides with this one. */
const SUFFIX = `${Date.now().toString(36)}`;
const emailOf = (name: string) => `auth-pkg-test-${name}-${SUFFIX}@example.com`;
/** Every setting this file overrides - saved before the suite, restored after each test. */
const SETTING_KEYS = [
  "auth.registration_enabled",
  "auth.email_verification_required",
  "auth.registration_default_role",
  "auth.max_sessions_per_user",
  "auth.session_idle_minutes",
  "auth.password_changed_email_enabled",
  "mfa.disabled_email_enabled",
  "auth.token_created_email_enabled",
  "auth.links.invitation",
  "system.public_url",
  "system.instance_name",
  "mail.templates.user_invitation",
  "mail.templates.password_reset",
] as const;

class CapturingEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string; html?: string }[] = [];
  async send(input: { to: string; subject: string; body?: string; html?: string }): Promise<void> {
    this.sent.push({ ...input, body: input.body ?? "" });
  }
  async verify(): Promise<void> {}
  lastToken(): string {
    const body = this.sent.at(-1)?.body ?? "";
    const match = /token=(\S+)/.exec(body);
    if (!match) throw new Error("no token captured");
    return match[1]!;
  }
}

/** No administrator and a fixed key: MFA itself is tested in mfa-service.test.ts. */
const MFA_OPTIONS = { masterKey: "auth-service-test-key", effectiveRoles: async () => [] };

describe("AuthService (integration)", () => {
  let database: Database;
  let settings: SettingsService;
  let emailSender: CapturingEmailSender;
  let auth: AuthService;
  /** Every user this file created - deleted by id in afterAll. */
  const userIds: string[] = [];
  const saved = new Map<string, { overridden: boolean; value: unknown }>();
  const createUser: AuthService["users"]["create"] = async (input) => {
    const user = await auth.users.create(input);
    userIds.push(user.id);
    return user;
  };
  const register = async (service: AuthService, input: Parameters<AuthService["register"]>[0]) => {
    const user = await service.register(input);
    userIds.push(user.id);
    return user;
  };
  async function restoreSettings(): Promise<void> {
    for (const key of SETTING_KEYS) {
      const entry = saved.get(key)!;
      if (entry.overridden) await settings.set(key, entry.value as never);
      else await settings.reset(key);
    }
  }

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    settings = new SettingsService(database);
    emailSender = new CapturingEmailSender();
    auth = new AuthService(database, settings, emailSender, { publicUrl: "https://env.example.com/", ...MFA_OPTIONS });
    for (const key of SETTING_KEYS) saved.set(key, { overridden: await settings.isOverridden(key), value: await settings.get(key) });
  });

  afterAll(async () => {
    for (const id of userIds.reverse()) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await restoreSettings();
    await database.close();
  });

  afterEach(async () => {
    await restoreSettings();
    // SettingsService caches reads in-process - a fresh one per test keeps
    // a deleted override from lingering.
    settings = new SettingsService(database);
    auth = new AuthService(database, settings, emailSender, { publicUrl: "https://env.example.com/", ...MFA_OPTIONS });
  });

  it("rejects registration when auth.registration_enabled is false (default)", async () => {
    await expect(
      register(auth, { email: emailOf("reg1"), password: "supersecret123" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("registers, requires strong passwords, and sends a verification email", async () => {
    await settings.set("auth.registration_enabled", true);
    await settings.set("auth.email_verification_required", true);

    await expect(
      register(auth, { email: emailOf("reg2"), password: "short" }),
    ).rejects.toBeInstanceOf(TotalBaseError);

    const user = await register(auth, {
      email: emailOf("reg2"),
      password: "supersecret123",
      name: "Test User",
    });
    expect(user.emailVerifiedAt).toBeNull();
    await auth.emailsSettled();
    expect(emailSender.sent.some((e) => e.to === user.email && e.subject.includes("Confirm your email"))).toBe(
      true,
    );
  });

  it("rejects duplicate registration email", async () => {
    await settings.set("auth.registration_enabled", true);
    await register(auth, { email: emailOf("dup"), password: "supersecret123" });
    await expect(
      register(auth, { email: emailOf("dup"), password: "supersecret123" }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  describe("auth.registration_default_role", () => {
    const roleIds: string[] = [];
    const createRole = async (name: string) => {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.roles (name) VALUES ($1) RETURNING id`,
        [`auth-pkg-test-${name}-${SUFFIX}`],
      );
      roleIds.push(rows[0]!.id);
      return rows[0]!.id;
    };
    const rolesOf = async (userId: string) =>
      (await database.query<{ role: string }>(`SELECT role FROM totalbase.users_roles WHERE "user" = $1`, [userId])).rows.map((r) => r.role);

    afterAll(async () => {
      // Users holding these roles are deleted in the outer afterAll, by id.
      for (const id of roleIds) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    });

    it("accepts only an existing role that is neither reserved nor admin_access", async () => {
      const reserved = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE reserved LIMIT 1`)).rows[0]!.id;
      await expect(settings.set("auth.registration_default_role", reserved)).rejects.toMatchObject({ code: "INVALID_SETTING" });
      await expect(settings.setGroup("auth", { registration_default_role: reserved })).rejects.toMatchObject({ code: "INVALID_SETTING" });
      await expect(settings.set("auth.registration_default_role", "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "INVALID_SETTING" });
      await expect(settings.set("auth.registration_default_role", "not-a-uuid")).rejects.toMatchObject({ code: "INVALID_SETTING" });
      expect(await settings.isOverridden("auth.registration_default_role")).toBe(false);

      const role = await createRole("ok");
      await settings.setGroup("auth", { registration_default_role: role });
      expect(await settings.get("auth.registration_default_role")).toBe(role);
      await settings.set("auth.registration_default_role", "");
      expect(await settings.isOverridden("auth.registration_default_role")).toBe(false);
    });

    it("gives the role to a self-registered account, and nothing without it", async () => {
      await settings.set("auth.registration_enabled", true);
      const none = await register(auth, { email: emailOf("defrole-none"), password: "supersecret123" });
      expect(await rolesOf(none.id)).toEqual([]);

      const role = await createRole("given");
      await settings.set("auth.registration_default_role", role);
      const given = await register(auth, { email: emailOf("defrole-given"), password: "supersecret123" });
      expect(await rolesOf(given.id)).toEqual([role]);

      // A role deleted after it was chosen is simply not given.
      await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [role]);
      const after = await register(auth, { email: emailOf("defrole-after"), password: "supersecret123" });
      expect(await rolesOf(after.id)).toEqual([]);
    });

    it("never gives a reserved role, even one stored behind the validator's back", async () => {
      await settings.set("auth.registration_enabled", true);
      const reserved = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE reserved AND admin_access LIMIT 1`)).rows[0]!.id;
      await database.query(
        `INSERT INTO totalbase.settings (key, value) VALUES ('auth.registration_default_role', $1::jsonb)`,
        [JSON.stringify(reserved)],
      );
      const fresh = new AuthService(database, new SettingsService(database), emailSender, { publicUrl: "https://env.example.com/", ...MFA_OPTIONS });
      const user = await register(fresh, { email: emailOf("defrole-reserved"), password: "supersecret123" });
      expect(await rolesOf(user.id)).toEqual([]);
    });
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    const passwordHash = await hashPassword("correct-horse-battery");
    const user = await createUser({ email: emailOf("login"), passwordHash, emailVerified: true });

    const result = await auth.login({ email: user.email!, password: "correct-horse-battery" });
    expect(result.token).toBeTruthy();
    expect(result.user.id).toBe(user.id);
    // Password hash must never leak into the login response.
    expect((result.user as unknown as Record<string, unknown>)["passwordHash"]).toBeUndefined();

    await expect(auth.login({ email: user.email!, password: "wrong" })).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("me() resolves the user for a valid token and fails after logout", async () => {
    const passwordHash = await hashPassword("correct-horse-battery");
    const user = await createUser({ email: emailOf("me"), passwordHash, emailVerified: true });
    const { token } = await auth.login({ email: user.email!, password: "correct-horse-battery" });

    expect((await auth.me(token)).id).toBe(user.id);

    await auth.logout(token);
    await expect(auth.me(token)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("password reset: issues a token, consumes it once, and revokes existing sessions", async () => {
    const passwordHash = await hashPassword("original-password");
    const user = await createUser({ email: emailOf("reset"), passwordHash, emailVerified: true });
    const { token: sessionToken } = await auth.login({
      email: user.email!,
      password: "original-password",
    });

    await auth.requestPasswordReset(user.email!);
    await auth.emailsSettled();
    const resetToken = emailSender.lastToken();

    await auth.resetPassword(resetToken, "brand-new-password");

    // Old session must be revoked by the password change.
    await expect(auth.me(sessionToken)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });

    // New password works, old one doesn't.
    await expect(
      auth.login({ email: user.email!, password: "original-password" }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    const relogin = await auth.login({ email: user.email!, password: "brand-new-password" });
    expect(relogin.token).toBeTruthy();

    // Token is single-use.
    await expect(auth.resetPassword(resetToken, "another-password-1")).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
  });

  // Security regression (Security.md §2.4): an unknown, locked, inactive or password-less account was refused before
  // Argon2 ran, a wrong password after - the answer's time told which emails have an account.
  it("takes as long to refuse an unknown email as a wrong password", async () => {
    const user = await createUser({ email: emailOf("timing"), passwordHash: await hashPassword("timing-password-1"), emailVerified: true });
    const elapsed = async (email: string) => {
      const started = performance.now();
      await auth.login({ email, password: "not-the-password" }).catch(() => undefined);
      return performance.now() - started;
    };
    const median = async (email: string) => {
      const runs = [await elapsed(email), await elapsed(email), await elapsed(email)].sort((a, b) => a - b);
      return runs[1]!;
    };
    await elapsed(emailOf("timing-warmup"));
    const known = await median(user.email!);
    const unknown = await median(emailOf("timing-nobody"));
    expect(unknown).toBeGreaterThan(known * 0.5);
    await database.query(`UPDATE totalbase.users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
  });

  // Security regression (Security.md §2.4): the lock was read before a proof was checked and written after it failed,
  // so guesses sent together all passed the check - far more than auth.lockout_max_attempts were ever tried.
  it("never checks more guesses than the lockout allows, however many arrive together", async () => {
    const user = await createUser({ email: emailOf("parallel"), passwordHash: await hashPassword("parallel-right-password"), emailVerified: true });
    const max = await settings.get("auth.lockout_max_attempts");
    try {
      const reasons: string[] = [];
      await Promise.allSettled(
        Array.from({ length: max * 3 }, (_, i) => auth.login({ email: user.email!, password: `wrong-${i}` }, (reason) => reasons.push(reason))),
      );
      expect(reasons.filter((reason) => reason === "wrong_password").length).toBeLessThanOrEqual(max);
      await database.query(`UPDATE totalbase.users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);

      const proofs = await Promise.allSettled(Array.from({ length: max * 3 }, (_, i) => auth.assertCurrentPassword(user.id, `wrong-${i}`)));
      const checked = proofs.filter((proof) => proof.status === "rejected" && /incorrect/.test(String((proof.reason as Error).message)));
      expect(checked.length).toBeLessThanOrEqual(max);
    } finally {
      await database.query(`UPDATE totalbase.users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    }
    await auth.assertCurrentPassword(user.id, "parallel-right-password");
    const { rows } = await database.query<{ failed_login_count: number }>(`SELECT failed_login_count FROM totalbase.users WHERE id = $1`, [user.id]);
    expect(rows[0]!.failed_login_count).toBe(0);
  });

  // Security regression (Security.md §2.4, SEC-35): five wrong passwords locked the account for everyone, so anyone
  // knowing an email kept its owner out. Now an address locks out only itself, and the account slows down - never
  // locks - for addresses it never signed in from.
  // Security regression (round 11, SEC-112): the password-check cap answered 429 only where a password was checked -
  // an existing account - while an unknown email's refusal swallowed it and answered 401 at once: under a flood the
  // status told which accounts exist. And the 429 came after the attempt was counted, so a real user retrying
  // "try again in a moment" locked their own address out with no expiry.
  it("a full password queue answers 429 alike for every email, before any attempt is counted", async () => {
    const user = await createUser({ email: emailOf("cap-oracle"), passwordHash: await hashPassword("cap-oracle-right-1"), emailVerified: true });
    const max = await settings.get("auth.lockout_max_attempts");
    // Every place taken: the turns and the queue behind them.
    const admitted = Array.from({ length: PASSWORD_CHECKS_AT_ONCE + PASSWORD_CHECKS_WAITING }, () => admitPasswordCheck());
    const codeOf = (email: string, password: string) =>
      auth.login({ email, password, ip: "203.0.113.90" }).then(() => "SIGNED_IN", (error: TotalBaseError) => error.code);
    try {
      expect(await codeOf(emailOf("cap-oracle-nobody"), "whatever-1")).toBe("RATE_LIMIT_EXCEEDED");
      for (let i = 0; i < max + 1; i++) expect(await codeOf(user.email!, "wrong-guess")).toBe("RATE_LIMIT_EXCEEDED");
      const { rows } = await database.query(`SELECT failed_count FROM totalbase.users_addresses WHERE "user" = $1`, [user.id]);
      expect(rows).toEqual([]);
    } finally {
      for (const check of admitted) check.release();
    }
    // The flood over, the owner signs in from that same address.
    await expect(auth.login({ email: user.email!, password: "cap-oracle-right-1", ip: "203.0.113.90" })).resolves.toMatchObject({ token: expect.any(String) });
  });

  // Security regression (round 12, SEC-116): a body without a password - or with a number, an object - made the check
  // throw: an account that has one answered 500 at once, any other email 401, and nothing counted the probe.
  it("answers a sign-in without a text password as a wrong password, for every email alike", async () => {
    const user = await createUser({ email: emailOf("no-text-password"), passwordHash: await hashPassword("no-text-right-1"), emailVerified: true });
    const codeOf = (email: string, password: unknown) =>
      auth.login({ email, password: password as string, ip: "203.0.113.92" }).then(() => "SIGNED_IN", (error: TotalBaseError) => error.code);
    for (const password of [undefined, 12345, { a: 1 }]) {
      expect(await codeOf(user.email!, password)).toBe("AUTHENTICATION_REQUIRED");
      expect(await codeOf(emailOf("no-text-nobody"), password)).toBe("AUTHENTICATION_REQUIRED");
    }
    // Each counted, as a wrong password is.
    const { rows } = await database.query<{ failed_count: number }>(`SELECT failed_count FROM totalbase.users_addresses WHERE "user" = $1`, [user.id]);
    expect(rows.map((row) => row.failed_count)).toEqual([3]);
    await auth.users.unlock(user.id);
  });

  // Security regression (round 12, SEC-117): a sign-in held its turn while it waited on the database - two sign-ins
  // for an account whose row someone kept locked took both turns, and every password check of the instance waited.
  it("a sign-in waiting on its account's row keeps no other password check from running", async () => {
    const user = await createUser({ email: emailOf("row-locked"), passwordHash: await hashPassword("row-locked-right-1"), emailVerified: true });
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = database.transaction(async (client) => {
      await client.query(`SELECT 1 FROM totalbase.users WHERE id = $1 FOR UPDATE`, [user.id]);
      locked();
      await held;
    });
    await lockTaken;
    const waiters = Array.from({ length: PASSWORD_CHECKS_AT_ONCE }, () =>
      auth.login({ email: user.email!, password: "row-locked-right-1", ip: "203.0.113.93" }).catch(() => undefined));
    try {
      const hashed = await Promise.race([hashPassword("someone-else-1").then(() => "HASHED"), new Promise((resolve) => setTimeout(() => resolve("WAITING"), 5000))]);
      expect(hashed).toBe("HASHED");
    } finally {
      unlock();
      await holder;
      await Promise.all(waiters);
    }
  });

  // Security regression (round 11, SEC-112): a check that failed for another reason than a wrong password kept its
  // attempt spent - the address counted toward its lockout for nothing.
  it("gives a sign-in attempt back when the password check itself fails", async () => {
    const user = await createUser({ email: emailOf("check-fails"), passwordHash: "not-an-argon2-hash", emailVerified: true });
    for (let i = 0; i < 3; i++) await auth.login({ email: user.email!, password: "anything-1", ip: "203.0.113.91" }).catch(() => undefined);
    const { rows } = await database.query<{ failed_count: number }>(`SELECT failed_count FROM totalbase.users_addresses WHERE "user" = $1`, [user.id]);
    expect(rows.map((row) => row.failed_count)).toEqual([0]);
  });

  it("locks an address out of an account, never the account: its owner signs in from where they always do", async () => {
    const user = await createUser({ email: emailOf("per-address"), passwordHash: await hashPassword("per-address-right-1"), emailVerified: true });
    const max = await settings.get("auth.lockout_max_attempts");
    const reasonsFrom = async (ip: string, password: string, times: number) => {
      const reasons: string[] = [];
      for (let i = 0; i < times; i++) await auth.login({ email: user.email!, password, ip }, (reason) => reasons.push(reason)).catch(() => undefined);
      return reasons;
    };
    // The owner's usual address, known from a sign-in.
    await auth.login({ email: user.email!, password: "per-address-right-1", ip: "198.51.100.7" });

    // An attacker from three addresses: each locks out after `max` wrong guesses - itself only.
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      const reasons = await reasonsFrom(ip, "wrong-guess", max + 2);
      expect(reasons.filter((reason) => reason === "wrong_password").length, ip).toBeLessThanOrEqual(max);
    }
    expect(await reasonsFrom("203.0.113.1", "per-address-right-1", 1)).toEqual(["address_locked"]);
    const { rows } = await database.query<{ locked: boolean }>(`SELECT coalesce(locked_until > now(), false) AS locked FROM totalbase.users WHERE id = $1`, [user.id]);
    expect(rows[0]!.locked).toBe(false);

    // The owner, from their address: in at once.
    const failures = async () => (await database.query<{ n: number }>(`SELECT sign_in_failures AS n FROM totalbase.users WHERE id = $1`, [user.id])).rows[0]!.n;
    const before = await failures();
    expect(before).toBeGreaterThanOrEqual(max);
    await expect(auth.login({ email: user.email!, password: "per-address-right-1", ip: "198.51.100.7" })).resolves.toMatchObject({ token: expect.any(String) });
    // Their success from a known address leaves the delay standing for the others - it doesn't reopen it to the
    // attacker: the count stays, and an address the account never signed in from waits its turn, its guess not even
    // checked. The delay itself lasts seconds - a slow run outlives it - so it is set ahead here, as a guess would.
    expect(await failures()).toBe(before);
    await database.query(`UPDATE totalbase.users SET sign_in_delayed_until = now() + interval '1 minute' WHERE id = $1`, [user.id]);
    expect(await reasonsFrom("192.0.2.50", "per-address-right-1", 1)).toEqual(["sign_in_delayed"]);
    await expect(auth.login({ email: user.email!, password: "per-address-right-1", ip: "198.51.100.7" })).resolves.toMatchObject({ token: expect.any(String) });
    // A password reset ends every address's lock.
    await auth.users.unlock(user.id);
    await expect(auth.login({ email: user.email!, password: "per-address-right-1", ip: "203.0.113.1" })).resolves.toMatchObject({ token: expect.any(String) });
  });

  // Security regression (round 7): addresses were counted whole, so one IPv6 /64 - 2^64 addresses - gave an attacker a
  // fresh address per guess, and an owner whose privacy address rotated was unknown the next day.
  it("counts an IPv6 address by its /64, and an administrator's Unlock account ends every address's lock", async () => {
    const user = await createUser({ email: emailOf("ipv6"), passwordHash: await hashPassword("ipv6-right-password"), emailVerified: true });
    const max = await settings.get("auth.lockout_max_attempts");
    const reasons: string[] = [];
    for (let i = 1; i <= max + 1; i++) await auth.login({ email: user.email!, password: "wrong", ip: `2001:db8:1:2::${i.toString(16)}` }, (reason) => reasons.push(reason)).catch(() => undefined);
    expect(reasons.at(-1)).toBe("address_locked");
    expect(reasons.filter((reason) => reason === "wrong_password").length).toBe(max);
    const { rows } = await database.query<{ ip: string }>(`SELECT ip::text FROM totalbase.users_addresses WHERE "user" = $1`, [user.id]);
    expect(rows.map((row) => row.ip)).toEqual(["2001:db8:1:2::/64"]);
    // Unlock account is a Data API row update on users (UserAdminEditor.vue): it frees the addresses too.
    await database.query(`UPDATE totalbase.users SET locked_until = NULL, failed_login_count = 0, sign_in_failures = 0, sign_in_delayed_until = NULL WHERE id = $1`, [user.id]);
    await expect(auth.login({ email: user.email!, password: "ipv6-right-password", ip: "2001:db8:1:2::99" })).resolves.toMatchObject({ token: expect.any(String) });
    // A sign-in's own success never counts as an unlock: it leaves the delay's end at now(), not NULL.
    const { rows: [after] } = await database.query<{ delayed: Date | null }>(`SELECT sign_in_delayed_until AS delayed FROM totalbase.users WHERE id = $1`, [user.id]);
    expect(after!.delayed).not.toBeNull();
  });

  // Security regression (Security.md §2.8): anyone may ask for an address's reset or verification link - asked again and
  // again, each request emailed the address and retired the link it got before, so a reset in progress never finished.
  it("sends one link per cooldown to an address anyone can ask for, and keeps the one already sent", async () => {
    const user = await createUser({ email: emailOf("cooldown"), passwordHash: await hashPassword("cooldown-password"), emailVerified: true });
    emailSender.sent = [];
    await auth.requestPasswordReset(user.email!);
    await auth.emailsSettled();
    const first = emailSender.lastToken();
    for (let i = 0; i < 3; i++) await auth.requestPasswordReset(user.email!);
    await auth.emailsSettled();
    expect(emailSender.sent).toHaveLength(1);
    await auth.resetPassword(first, "after-cooldown-password");
    expect((await auth.login({ email: user.email!, password: "after-cooldown-password" })).token).toBeTruthy();

    const unverified = await createUser({ email: emailOf("cooldown-verify"), passwordHash: await hashPassword("cooldown-password") });
    emailSender.sent = [];
    for (let i = 0; i < 3; i++) await auth.resendEmailVerificationByEmail(unverified.email!);
    await auth.emailsSettled();
    expect(emailSender.sent).toHaveLength(1);
  });

  // Security regression (Security.md §2.8): past the cooldown, the next request anyone made still retired the link
  // the owner was using - asked once a minute, a reset never finished.
  it("never retires the link in progress when a new one is asked for past the cooldown", async () => {
    const user = await createUser({ email: emailOf("cooldown-past"), passwordHash: await hashPassword("cooldown-password"), emailVerified: true });
    emailSender.sent = [];
    await auth.requestPasswordReset(user.email!);
    await auth.emailsSettled();
    const first = emailSender.lastToken();
    // The cooldown has passed.
    await database.query(`UPDATE totalbase.emails_tokens SET created_at = now() - interval '2 minutes' WHERE "user" = $1`, [user.id]);
    await auth.requestPasswordReset(user.email!);
    await auth.emailsSettled();
    const second = emailSender.lastToken();
    expect(second).not.toBe(first);
    await auth.resetPassword(first, "first-link-still-works");
    expect((await auth.login({ email: user.email!, password: "first-link-still-works" })).token).toBeTruthy();
    // Used, it retires the other.
    await expect(auth.resetPassword(second, "second-link-retired")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  // Security regression (Security.md §2.8, §2.9): POST /api/auth/password/change kept every other session and pending
  // link alive, a reset kept a pending invitation that would set the password again, and accepting an invitation on
  // an account that had a password kept its sessions.
  it("a password change, a reset and a re-invitation end what the old password opened", async () => {
    const user = await createUser({ email: emailOf("aftermath"), passwordHash: await hashPassword("aftermath-pass-1"), emailVerified: true });
    const pending = async () => (await database.query(`SELECT 1 FROM totalbase.emails_tokens WHERE "user" = $1 AND used_at IS NULL`, [user.id])).rows.length;

    const mine = await auth.login({ email: user.email!, password: "aftermath-pass-1" });
    const stolen = await auth.login({ email: user.email!, password: "aftermath-pass-1" });
    await auth.createInvitation({ id: user.id, email: user.email!, name: null }, "link");
    await auth.changePassword(user.id, "aftermath-pass-1", "aftermath-pass-2", (await auth.sessions.validate(mine.token))!.session.id);
    expect(await auth.sessions.validate(mine.token)).not.toBeNull();
    expect(await auth.sessions.validate(stolen.token)).toBeNull();
    expect(await pending()).toBe(0);

    // SEC-64: a token made with the old password survived a reset - the way an account is taken back.
    const liveTokens = async () => (await database.query(`SELECT 1 FROM totalbase.tokens WHERE "user" = $1 AND revoked_at IS NULL`, [user.id])).rows.length;
    await database.query(`INSERT INTO totalbase.tokens ("user", name, key_prefix, key_hash) VALUES ($1, 'intruder', 'tb_in', $2)`, [user.id, `intruder-${user.id}`]);
    await auth.createInvitation({ id: user.id, email: user.email!, name: null }, "link");
    await auth.requestPasswordReset(user.email!);
    await auth.emailsSettled();
    await auth.resetPassword(emailSender.lastToken(), "aftermath-pass-3");
    expect(await pending()).toBe(0);
    expect(await liveTokens()).toBe(0);

    const session = await auth.login({ email: user.email!, password: "aftermath-pass-3" });
    await auth.createInvitation({ id: user.id, email: user.email!, name: null });
    await auth.emailsSettled();
    await auth.acceptInvitation(emailSender.lastToken(), "aftermath-pass-4");
    expect(await auth.sessions.validate(session.token)).toBeNull();
  });

  it("changePassword requires the current password to match (400 INVALID_CURRENT_PASSWORD, like My account)", async () => {
    const passwordHash = await hashPassword("current-pw-12345");
    const user = await createUser({ email: emailOf("change"), passwordHash, emailVerified: true });

    await expect(
      auth.changePassword(user.id, "wrong-current", "new-password-123"),
    ).rejects.toMatchObject({ code: "INVALID_CURRENT_PASSWORD", httpStatus: 400 });

    await auth.changePassword(user.id, "current-pw-12345", "new-password-123");
    const result = await auth.login({ email: user.email!, password: "new-password-123" });
    expect(result.token).toBeTruthy();
  });

  describe("auth.email_verification_required gates sign-in", () => {
    it("refuses an unverified account with EMAIL_NOT_VERIFIED only after the password matched, audited as email_not_verified", async () => {
      await settings.set("auth.email_verification_required", true);
      const user = await createUser({ email: emailOf("gate"), passwordHash: await hashPassword("gate-password-1") });
      expect(user.emailVerifiedAt).toBeNull();

      // A wrong password is still the generic 401 - nothing about verification leaks.
      await expect(auth.login({ email: user.email, password: "wrong-password-1" })).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", httpStatus: 401 });

      const reasons: string[] = [];
      await expect(auth.login({ email: user.email, password: "gate-password-1" }, (reason) => reasons.push(reason)))
        .rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED", httpStatus: 403 });
      expect(reasons).toEqual(["email_not_verified"]);

      // The resend without a session sends a link; following it lets them in.
      emailSender.sent = [];
      await auth.resendEmailVerificationByEmail(user.email);
      await auth.emailsSettled();
      expect(emailSender.sent.map((e) => e.to)).toEqual([user.email]);
      await auth.emailsSettled();
      await auth.verifyEmail(emailSender.lastToken());
      expect((await auth.login({ email: user.email, password: "gate-password-1" })).token).toBeTruthy();

      // Already verified: nothing more is sent, by either resend.
      emailSender.sent = [];
      await auth.resendEmailVerificationByEmail(user.email);
      await auth.resendEmailVerification(user.id);
      await auth.emailsSettled();
      expect(emailSender.sent).toEqual([]);
    });

    it("lets an unverified account sign in while verification is not required", async () => {
      await settings.set("auth.email_verification_required", false);
      const user = await createUser({ email: emailOf("gate-off"), passwordHash: await hashPassword("gate-password-1") });
      expect((await auth.login({ email: user.email, password: "gate-password-1" })).token).toBeTruthy();
    });

    it("resend by email never tells whether an account exists", async () => {
      emailSender.sent = [];
      await expect(auth.resendEmailVerificationByEmail(emailOf("nobody"))).resolves.toBeUndefined();
      await auth.emailsSettled();
      expect(emailSender.sent).toEqual([]);
    });

    it("a password reset verifies the email - the link only reached the person through it", async () => {
      await settings.set("auth.email_verification_required", true);
      const user = await createUser({ email: emailOf("gate-reset"), passwordHash: await hashPassword("gate-password-1") });
      await auth.requestPasswordReset(user.email);
      await auth.emailsSettled();
      await auth.resetPassword(emailSender.lastToken(), "gate-password-2");
      expect((await auth.login({ email: user.email, password: "gate-password-2" })).token).toBeTruthy();
    });

    it("an administrator giving an invited shell its first password verifies it", async () => {
      await settings.set("auth.email_verification_required", true);
      const user = await createUser({ email: emailOf("gate-admin-set") });
      await auth.adminSetPassword({ userId: user.id, password: "gate-password-1", signOut: false });
      expect((await auth.login({ email: user.email, password: "gate-password-1" })).token).toBeTruthy();
    });
  });

  it("verifyEmail marks the user verified and consumes the token", async () => {
    const user = await createUser({ email: emailOf("verify") });
    await auth.sendEmailVerification(user.id, user.email!);
    await auth.emailsSettled();
    const token = emailSender.lastToken();

    await auth.verifyEmail(token);
    const updated = await auth.users.findById(user.id);
    expect(updated?.emailVerifiedAt).not.toBeNull();

    await expect(auth.verifyEmail(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("invitation flow: accept sets a password, verifies email, and returns a session", async () => {
    const user = await createUser({
      email: emailOf("invite"),
      name: "Invited",
    });
    await auth.createInvitation({ id: user.id, email: user.email!, name: user.name });
    await auth.emailsSettled();
    const token = emailSender.lastToken();

    const result = await auth.acceptInvitation(token, "invited-password-1");
    expect(result.token).toBeTruthy();
    expect(result.user.emailVerifiedAt).not.toBeNull();

    const login = await auth.login({ email: user.email!, password: "invited-password-1" });
    expect(login.token).toBeTruthy();
  });

  it("enforces auth.max_sessions_per_user by revoking the oldest sessions", async () => {
    const passwordHash = await hashPassword("many-sessions-pw");
    const user = await createUser({
      email: emailOf("maxsessions"),
      passwordHash,
      emailVerified: true,
    });
    await settings.set("auth.max_sessions_per_user", 2);

    const first = await auth.login({ email: user.email!, password: "many-sessions-pw" });
    const _second = await auth.login({ email: user.email!, password: "many-sessions-pw" });
    const third = await auth.login({ email: user.email!, password: "many-sessions-pw" });

    // Oldest (first) session should have been revoked once the cap was exceeded.
    await expect(auth.me(first.token)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect((await auth.me(third.token)).id).toBe(user.id);
  });

  it("ends a session unused for auth.session_idle_minutes, everywhere its status is read", async () => {
    const user = await createUser({
      email: emailOf("idle"),
      passwordHash: await hashPassword("idle-session-pw"),
      emailVerified: true,
    });
    const login = await auth.login({ email: user.email!, password: "idle-session-pw" });
    const { session } = (await auth.sessions.validate(login.token))!;
    // Last used 40 minutes ago.
    await database.query(`UPDATE totalbase.sessions SET last_seen_at = now() - interval '40 minutes' WHERE id = $1`, [session.id]);
    const status = async () => {
      const page = await auth.sessions.search({ user: user.id, status: "ALL", offset: 0 });
      return { counts: page.counts, expiresAt: page.sessions[0]!.expiresAt };
    };

    // Off (0): only the lifetime counts.
    await settings.set("auth.session_idle_minutes", 0);
    expect((await status()).counts).toMatchObject({ ACTIVE: 1, EXPIRED: 0 });
    // 60 minutes: still within it, and it ends 60 minutes after its last use.
    await settings.set("auth.session_idle_minutes", 60);
    const within = await status();
    expect(within.counts).toMatchObject({ ACTIVE: 1, EXPIRED: 0 });
    expect(within.expiresAt.getTime() - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(within.expiresAt.getTime() - Date.now()).toBeLessThan(21 * 60_000);
    // 30 minutes: idle too long - refused, listed as expired, not counted as signed in.
    await settings.set("auth.session_idle_minutes", 30);
    const activeBefore = await auth.sessions.countActive();
    expect(await auth.sessions.validate(login.token)).toBeNull();
    await expect(auth.me(login.token)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect((await status()).counts).toMatchObject({ ACTIVE: 0, EXPIRED: 1 });
    await settings.set("auth.session_idle_minutes", 0);
    expect(await auth.sessions.countActive()).toBeGreaterThanOrEqual(activeBefore + 1);
    // A refused request never revives it: back on, still refused.
    await settings.set("auth.session_idle_minutes", 30);
    expect(await auth.sessions.validate(login.token)).toBeNull();
  });

  describe("system emails", () => {
    async function invitee(suffix: string) {
      const user = await createUser({ email: emailOf(`mail-${suffix}`), name: "Mail Test" });
      return { id: user.id, email: user.email!, name: user.name };
    }

    it("builds links on TOTALBASE_PUBLIC_URL until system.public_url is set", async () => {
      const user = await invitee("link-base");
      const first = await auth.createInvitation(user, "link");
      expect(first).toMatch(/^https:\/\/env\.example\.com\/auth\/accept-invitation\?token=/);

      await settings.set("system.public_url", "https://app.example.com");
      const second = await auth.createInvitation(user, "link");
      expect(second).toMatch(/^https:\/\/app\.example\.com\/auth\/accept-invitation\?token=/);

      await settings.set("auth.links.invitation", "https://myapp.example.com/join/{{token}}");
      expect(await auth.createInvitation(user, "link")).toMatch(/^https:\/\/myapp\.example\.com\/join\/[^/?]+$/);
    });

    it("renders the invitation from the template, escaping values in the HTML body", async () => {
      const user = await createUser({ email: emailOf("mail-render"), name: "<b>Ana</b>" });
      await settings.set("system.instance_name", "Acme");
      await auth.createInvitation({ id: user.id, email: user.email!, name: user.name });
      await auth.emailsSettled();
      const email = emailSender.sent.at(-1)!;
      expect(email.subject).toBe("You've been invited to Acme");
      expect(email.body).toContain("Hi <b>Ana</b>,");
      expect(email.html).toContain("Hi &lt;b&gt;Ana&lt;/b&gt;,");
      expect(email.body).toContain("7 days");
    });

    it("uses an admin's template override", async () => {
      await settings.set("mail.templates.user_invitation", {
        subject: "Join {{instance.name}}",
        html: "",
        text: "Go: {{action_url}}",
      });
      await auth.createInvitation(await invitee("override"));
      await auth.emailsSettled();
      const email = emailSender.sent.at(-1)!;
      expect(email.subject).toBe("Join TotalBase");
      expect(email.body).toMatch(/^Go: https:\/\/env\.example\.com\//);
      expect(email.html).toBeUndefined();
    });

    it("rejects templates with unknown variables or without the action link", async () => {
      await expect(
        settings.set("mail.templates.user_invitation", { subject: "Hi {{user.password}}", html: "", text: "{{action_url}}" }),
      ).rejects.toMatchObject({ code: "INVALID_SETTING" });
      await expect(
        settings.set("mail.templates.password_reset", { subject: "Reset", html: "", text: "No link here" }),
      ).rejects.toMatchObject({ code: "INVALID_SETTING" });
      await expect(settings.set("auth.links.invitation", "https://example.com/no-token")).rejects.toMatchObject({
        code: "INVALID_SETTING",
      });
      await expect(settings.set("system.public_url", "ftp://example.com")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    });

    it("link delivery sends nothing, and a new link retires the previous one", async () => {
      const user = await invitee("retire");
      await auth.emailsSettled();
      const before = emailSender.sent.length;
      const oldLink = await auth.createInvitation(user, "link");
      const newLink = await auth.createInvitation(user, "link");
      await auth.emailsSettled();
      expect(emailSender.sent.length).toBe(before);

      const tokenOf = (link: string) => decodeURIComponent(new URL(link).searchParams.get("token")!);
      await expect(auth.acceptInvitation(tokenOf(oldLink), "invited-password-1")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
      await expect(auth.acceptInvitation(tokenOf(newLink), "invited-password-1")).resolves.toMatchObject({ user: { id: user.id } });
    });

    it("the public password reset never reports a delivery failure", async () => {
      const failing = new AuthService(database, settings, {
        send: async () => {
          throw new TotalBaseError("SMTP_NOT_CONFIGURED", "not configured");
        },
        verify: async () => {},
      }, MFA_OPTIONS);
      const passwordHash = await hashPassword("reset-me-password");
      const user = await createUser({ email: emailOf("mail-forgot"), passwordHash, emailVerified: true });
      await expect(failing.requestPasswordReset(user.email!)).resolves.toBeUndefined();
      // The admin path reports it.
      await expect(
        failing.sendPasswordReset({ id: user.id, email: user.email!, name: null }, "email"),
      ).rejects.toMatchObject({ code: "SMTP_NOT_CONFIGURED" });
    });

    it("sends a password changed notice after a reset, unless turned off", async () => {
      const passwordHash = await hashPassword("before-reset-password");
      const user = await createUser({ email: emailOf("mail-notice"), passwordHash, emailVerified: true });
      await auth.requestPasswordReset(user.email!);
      await auth.emailsSettled();
      await auth.resetPassword(emailSender.lastToken(), "after-reset-password-1");
      await auth.emailsSettled();
      expect(emailSender.sent.at(-1)!.subject).toContain("password was changed");

      await settings.set("auth.password_changed_email_enabled", false);
      await auth.requestPasswordReset(user.email!);
      await auth.emailsSettled();
      const count = emailSender.sent.length;
      await auth.emailsSettled();
      await auth.resetPassword(emailSender.lastToken(), "after-reset-password-2");
      await auth.emailsSettled();
      expect(emailSender.sent.length).toBe(count);
    });

    it("sends the two-factor turned off and new API token notices to the account, unless turned off", async () => {
      const user = await createUser({ email: emailOf("mail-security"), name: "Notice Person", emailVerified: true });
      await auth.notifyMfaDisabled(user.id);
      await auth.emailsSettled();
      expect(emailSender.sent.at(-1)).toMatchObject({ to: user.email, subject: expect.stringContaining("Two-factor authentication was turned off") });

      await auth.notifyTokenCreated(user.id, { name: "deploy-bot", plane: "ADMIN" });
      await auth.emailsSettled();
      expect(emailSender.sent.at(-1)!.to).toBe(user.email);
      expect(emailSender.sent.at(-1)!.body).toContain("deploy-bot (ADMIN)");

      await settings.set("mfa.disabled_email_enabled", false);
      await settings.set("auth.token_created_email_enabled", false);
      const count = emailSender.sent.length;
      await auth.notifyMfaDisabled(user.id);
      await auth.notifyTokenCreated(user.id, { name: "deploy-bot", plane: "API" });
      await auth.emailsSettled();
      expect(emailSender.sent.length).toBe(count);
    });
  });
});
