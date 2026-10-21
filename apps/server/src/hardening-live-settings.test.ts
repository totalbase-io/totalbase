import type { FastifyInstance } from "fastify";
import type { SettingKey } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/**
 * The real server, the real settings service: a setting saved while the
 * server runs governs the very next request (Administration.md
 * §7.5) - no restart, no rebuilt app.
 */
describe("hardening settings applied live (integration)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  const KEYS: SettingKey[] = ["security.cors_origins", "api.max_body_bytes", "api.max_query_parameters"];

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
  });

  afterAll(async () => {
    for (const key of KEYS) await context.settings.reset(key);
    await app.close();
  });

  it("a CORS origin added through the settings is honored on the next request", async () => {
    const origin = "https://live-cors.example.com";
    const before = await app.inject({ method: "GET", url: "/health/live", headers: { origin } });
    expect(before.headers["access-control-allow-origin"]).toBeUndefined();
    await context.settings.set("security.cors_origins", [origin]);
    const after = await app.inject({ method: "GET", url: "/health/live", headers: { origin } });
    expect(after.headers["access-control-allow-origin"]).toBe(origin);
  });

  it("a lowered body limit refuses the next oversized body with REQUEST_BODY_TOO_LARGE", async () => {
    await context.settings.set("api.max_body_bytes", 1024);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x".repeat(2000), password: "y" } });
    expect(res.statusCode).toBe(413);
    expect(res.json().errors[0].code).toBe("REQUEST_BODY_TOO_LARGE");
    await context.settings.reset("api.max_body_bytes");
    const ok = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x".repeat(2000), password: "y" } });
    expect(ok.statusCode).not.toBe(413);
  });

  it("a lowered query parameter limit applies to the next request", async () => {
    await context.settings.set("api.max_query_parameters", 1);
    const res = await app.inject({ method: "GET", url: "/health/live?a=1&b=2" });
    expect(res.json().errors[0].code).toBe("QUERY_PARAMETER_LIMIT_EXCEEDED");
  });
});
