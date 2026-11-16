import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { cleanupTracked, setupTestApp, track, uniqueSuffix } from "./test-support.js";

const P = `invitation-vars-${uniqueSuffix()}`;

interface SentEmail { to: string; subject: string; body?: string; html?: string }

/**
 * The invitation email's own variables (Security.md §2.9): who invites, the account's roles and the caller's
 * `message` - on the invitation and on its resend, through the Data API's routes and the Admin API's.
 */
describe("invitation email variables", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let admin: { id: string; name: string | null; email: string | null };
  let roleId: string;
  const sent: SentEmail[] = [];
  let restoreSender: () => void;

  const call = (method: "POST" | "PUT", url: string, data: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` }, payload: { data } as Record<string, unknown> });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    admin = await context.auth.me(adminToken);
    roleId = track("roles", (await context.roles.create(`${P}-Technician`, { apiAccess: true })).id);

    // The system mailer's own sender, captured: what would have left.
    const mailer = context.auth.mailer as unknown as { emailSender: { send(input: SentEmail): Promise<void> } };
    const original = mailer.emailSender;
    mailer.emailSender = { send: async (input) => { sent.push(input); } };
    restoreSender = () => { mailer.emailSender = original; };

    const saved = await call("PUT", "/admin/api/system-emails/user_invitation", {
      subject: "{{inviter.name}} invited you to {{instance.name}}",
      html: "<p>{{inviter.name}} ({{inviter.email}}) invited you as {{roles}}.</p><p>{{message}}</p><p>{{action_url}}</p>",
      text: "{{inviter.name}} invited you as {{roles}}. {{message}} {{action_url}}",
    });
    expect(saved.statusCode, saved.body).toBe(200);
  });

  beforeEach(() => { sent.length = 0; });

  afterAll(async () => {
    restoreSender();
    await context.settings.reset("mail.templates.user_invitation");
    await cleanupTracked(database);
    await app.close();
  });

  const inviterName = () => admin.name?.trim() || admin.email!;

  it("an invitation names who invites, the roles and the caller's message - escaped in the HTML body", async () => {
    const res = await call("POST", "/api/totalbase/table/users/invitations", {
      email: `${P}-ana@example.com`, name: "Ana", roles: [roleId], message: "Welcome to <Acme> & co.",
    });
    expect(res.statusCode, res.body).toBe(201);
    track("users", res.json().data.id);
    expect(res.json().meta).toEqual({ delivered: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(`${P}-ana@example.com`);
    expect(sent[0]!.subject).toBe(`${inviterName()} invited you to ${await context.settings.get("system.instance_name")}`);
    expect(sent[0]!.html).toContain(`(${admin.email}) invited you as ${P}-Technician.`);
    expect(sent[0]!.html).toContain("<p>Welcome to &lt;Acme&gt; &amp; co.</p>");
    expect(sent[0]!.body).toContain(`invited you as ${P}-Technician. Welcome to <Acme> & co. http`);
  });

  it("a resend carries them too - by the Data API's route and the Admin API's", async () => {
    const created = await call("POST", "/api/totalbase/table/users/invitations", { email: `${P}-bea@example.com`, roles: [roleId] });
    const id = track("users", created.json().data.id as string);
    sent.length = 0;

    const resent = await call("POST", `/api/totalbase/table/users/${id}/invite`, { message: "Second try" });
    expect(resent.statusCode, resent.body).toBe(200);
    const again = await call("POST", `/admin/api/users/${id}/invite`, { message: "Third try" });
    expect(again.statusCode, again.body).toBe(200);

    expect(sent.map((email) => email.body)).toEqual([
      expect.stringContaining(`${inviterName()} invited you as ${P}-Technician. Second try http`),
      expect.stringContaining(`${inviterName()} invited you as ${P}-Technician. Third try http`),
    ]);
  });

  it("refuses a message that isn't text of at most 500 characters, before creating anything", async () => {
    for (const message of ["x".repeat(501), 42, { text: "hi" }]) {
      const res = await call("POST", "/api/totalbase/table/users/invitations", { email: `${P}-long@example.com`, message });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("INVALID_QUERY");
    }
    expect(await context.auth.users.findByEmail(`${P}-long@example.com`)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("the default template says none of it - a message reaches the email only where the administrator's template asks", async () => {
    await context.settings.reset("mail.templates.user_invitation");
    const res = await call("POST", "/api/totalbase/table/users/invitations", { email: `${P}-caro@example.com`, message: "Buy now at evil.example" });
    track("users", res.json().data.id);
    expect(sent).toHaveLength(1);
    expect(`${sent[0]!.subject} ${sent[0]!.html} ${sent[0]!.body}`).not.toContain("evil.example");
  });

  it("still refuses a template with a variable the slot doesn't have", async () => {
    const res = await call("PUT", "/admin/api/system-emails/user_invitation", { subject: "s", html: "", text: "{{extra.tenant}} {{action_url}}" });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe("INVALID_SETTING");
    const other = await call("PUT", "/admin/api/system-emails/password_reset", { subject: "s", html: "", text: "{{inviter.name}} {{action_url}}" });
    expect(other.statusCode).toBe(400);
  });
});
