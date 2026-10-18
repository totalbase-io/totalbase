import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SettingKey } from "@totalbase/settings";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

/**
 * SMTP "Test connection" (Specification_Administration.md §8.1):
 * `POST /admin/api/settings/mail/verify` connects and authenticates through
 * the saved smtp.* settings without sending. A tiny local relay speaks just
 * enough SMTP (greeting, EHLO with AUTH PLAIN, AUTH, QUIT) and records the
 * commands it got - none of them may be MAIL FROM.
 */
describe("SMTP connection test", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let adminToken: string;
  let relay: Server;
  let relayPort: number;
  const commands: string[] = [];
  const USER = "relay-user";
  const PASSWORD = `relay-${randomBytes(6).toString("hex")}`;
  const secretKey = `smtp-verify-test-${randomBytes(4).toString("hex")}`;
  const KEYS: SettingKey[] = ["smtp.host", "smtp.port", "smtp.secure", "smtp.username", "smtp.password_secret_key", "smtp.from"];
  const saved = new Map<SettingKey, { overridden: boolean; value: unknown }>();

  const verify = () =>
    app.inject({ method: "POST", url: "/admin/api/settings/mail/verify", headers: { authorization: `Bearer ${adminToken}` } });

  function speakSmtp(socket: Socket): void {
    socket.write("220 stub ESMTP\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line.split(" ")[0]!.toUpperCase());
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250-stub\r\n250 AUTH PLAIN\r\n");
        else if (verb === "AUTH") {
          const [user, pass] = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").split("\0").slice(1);
          socket.write(user === USER && pass === PASSWORD ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Bad credentials\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 not implemented\r\n");
      }
    });
    socket.on("error", () => {});
  }

  async function useRelay(options: { port: number; password: string }): Promise<void> {
    await context.secrets.set(secretKey, options.password);
    await context.settings.set("smtp.host", "127.0.0.1");
    await context.settings.set("smtp.port", options.port);
    await context.settings.set("smtp.secure", false);
    await context.settings.set("smtp.username", USER);
    await context.settings.set("smtp.password_secret_key", secretKey);
    await context.settings.set("smtp.from", "totalbase@example.com");
  }

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    for (const key of KEYS) saved.set(key, { overridden: await context.settings.isOverridden(key), value: await context.settings.get(key) });
    relay = createServer(speakSmtp);
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    relayPort = (relay.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const [key, { overridden, value }] of saved) {
      if (overridden) await context.settings.set(key, value as never);
      else await context.settings.reset(key);
    }
    await context.secrets.delete(secretKey);
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await app.close();
  });

  it("answers 204 when the relay accepts the credentials, and sends nothing", async () => {
    await useRelay({ port: relayPort, password: PASSWORD });
    commands.length = 0;
    const res = await verify();
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    expect(commands).toContain("AUTH");
    expect(commands).not.toContain("MAIL");
    expect(commands).not.toContain("RCPT");
  });

  it("reports refused credentials with the relay's own reason, never the password", async () => {
    await useRelay({ port: relayPort, password: "wrong-password" });
    const res = await verify();
    expect([res.statusCode, res.json().errors[0].code]).toEqual([502, "SMTP_CONNECTION_FAILED"]);
    expect(res.json().errors[0].message).toContain("Bad credentials");
    expect(res.body).not.toContain("wrong-password");
  });

  it("reports a relay that refuses the connection", async () => {
    // A port nothing listens on: bind one, then free it.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await useRelay({ port, password: PASSWORD });
    const res = await verify();
    expect([res.statusCode, res.json().errors[0].code]).toEqual([502, "SMTP_CONNECTION_FAILED"]);
    expect(res.json().errors[0].message).toMatch(/ECONNREFUSED/);
  });

  it("is SMTP_NOT_CONFIGURED without a host, and administrators only", async () => {
    await context.settings.set("smtp.host", "");
    const res = await verify();
    expect([res.statusCode, res.json().errors[0].code]).toEqual([409, "SMTP_NOT_CONFIGURED"]);
    const anonymous = await app.inject({ method: "POST", url: "/admin/api/settings/mail/verify" });
    expect(anonymous.statusCode).toBe(401);
  });
});
