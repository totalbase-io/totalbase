import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

/**
 * System emails (Administration.md §8.2) - templates as settings overrides,
 * edited through /admin/api/system-emails - and the admin invite/reset
 * routes' `delivery: "link"` mode.
 */
describe("/admin/api/system-emails", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const createdUserIds: string[] = [];

  const inject = (method: "GET" | "PUT" | "DELETE" | "POST", url: string, payload?: Record<string, unknown>) =>
    payload === undefined
      ? app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` } })
      : app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` }, payload: { data: payload } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await context.settings.reset("mail.templates.user_invitation");
    await context.settings.reset("system.public_url");
    if (createdUserIds.length > 0) {
      await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [createdUserIds]);
    }
    await app.close();
  });

  it("lists the eight system emails with their variables", async () => {
    const res = await inject("GET", "/admin/api/system-emails");
    expect(res.statusCode).toBe(200);
    const slots = res.json().data.map((e: { slot: string }) => e.slot);
    expect(slots).toEqual(["user_invitation", "password_reset", "email_verification", "password_changed", "email_changed", "mfa_disabled", "token_created", "user_welcome"]);
    const token = res.json().data.find((e: { slot: string }) => e.slot === "token_created");
    expect(token).toMatchObject({ hasAction: false, enabled: true, enabledSetting: "auth.token_created_email_enabled" });
    expect(token.variables).toEqual(expect.arrayContaining(["token.name", "token.plane"]));
    const welcome = res.json().data.find((e: { slot: string }) => e.slot === "user_welcome");
    expect(welcome).toMatchObject({ hasAction: false, enabled: false, enabledSetting: "auth.welcome_email_enabled" });
    const changed = res.json().data.find((e: { slot: string }) => e.slot === "email_changed");
    expect(changed).toMatchObject({ hasAction: false, enabled: true, enabledSetting: "auth.email_changed_email_enabled" });
    expect(changed.variables).toContain("new_email");
  });

  it("previews the email_changed notice with a sample new address", async () => {
    const detail = (await inject("GET", "/admin/api/system-emails/email_changed")).json().data;
    const preview = await inject("POST", "/admin/api/system-emails/email_changed/preview", detail.template);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.text).toContain("new-address@example.com");
  });

  it("saves an override, previews it, and restores the default", async () => {
    const template = { subject: "Join {{instance.name}}", html: "<p>{{user.name}}: <a href=\"{{action_url}}\">go</a></p>", text: "" };
    const put = await inject("PUT", "/admin/api/system-emails/user_invitation", template);
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({ overridden: true, template });

    await context.settings.set("system.public_url", "https://public.example.com");
    const preview = await inject("POST", "/admin/api/system-emails/user_invitation/preview", template);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.html).toContain("https://public.example.com/auth/accept-invitation?token=sample-token");

    const reset = await inject("DELETE", "/admin/api/system-emails/user_invitation");
    expect(reset.json().data).toMatchObject({ overridden: false });
    expect(reset.json().data.template).toEqual(reset.json().data.defaultTemplate);
  });

  it("rejects an invalid template and an unknown slot", async () => {
    const bad = await inject("PUT", "/admin/api/system-emails/password_reset", { subject: "x", html: "", text: "{{secret}}" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].code).toBe("INVALID_SETTING");
    expect((await inject("GET", "/admin/api/system-emails/nope")).statusCode).toBe(404);
  });

  it("requires an admin", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/api/system-emails" })).statusCode).toBe(401);
  });

  it("invite with delivery=link returns a working link without sending", async () => {
    const created = await inject("POST", "/admin/api/users", { email: "system-emails-test-link@example.com", name: "Link" });
    const userId = created.json().data.id as string;
    createdUserIds.push(userId);

    const res = await inject("POST", `/admin/api/users/${userId}/invite`, { delivery: "link" });
    expect(res.statusCode).toBe(200);
    const { actionUrl, delivered } = res.json().data;
    expect(delivered).toBe(false);
    const token = new URL(actionUrl).searchParams.get("token")!;

    const accept = await app.inject({
      method: "POST",
      url: "/api/auth/invitations/accept",
      payload: { token, password: "a-strong-enough-password" },
    });
    expect(accept.statusCode).toBe(200);
  });

  it("rejects an unknown delivery mode", async () => {
    const res = await inject("POST", `/admin/api/users/${createdUserIds[0]}/invite`, { delivery: "sms" });
    expect(res.statusCode).toBe(400);
  });
});
