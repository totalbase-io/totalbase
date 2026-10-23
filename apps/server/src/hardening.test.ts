import { Readable } from "node:stream";
import Fastify from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingKey } from "@totalbase/settings";
import { describe, expect, it } from "vitest";
import {
  FASTIFY_BODY_LIMIT_CEILING,
  QUERY_STRING_DEPTH_LIMIT,
  QUERY_STRING_PAIR_LIMIT,
  parseQueryString,
  registerHardeningHooks,
  type HardeningSettingsSource,
} from "./hardening.js";

interface HardeningSettings {
  maxBodyBytes: number;
  maxQueryStringBytes: number;
  maxQueryParameters: number;
  rateLimitEnabled: boolean;
  rateLimitPerMinute: number;
  signInPerMinute: number;
  corsEnabled: boolean;
  corsOrigins: string[];
}

/** A settings source whose values the test can change between requests - the hooks must pick a change up on the next one. */
function baseSettings(overrides: Partial<HardeningSettings> = {}): HardeningSettings {
  return {
    maxBodyBytes: 5_000_000,
    maxQueryStringBytes: 32_768,
    maxQueryParameters: 200,
    rateLimitEnabled: true,
    rateLimitPerMinute: 300,
    signInPerMinute: 2,
    corsEnabled: true,
    corsOrigins: ["https://allowed.example.com"],
    ...overrides,
  };
}

function sourceOf(values: HardeningSettings): HardeningSettingsSource {
  const keys: Partial<Record<SettingKey, keyof HardeningSettings>> = {
    "api.max_body_bytes": "maxBodyBytes",
    "api.max_query_string_bytes": "maxQueryStringBytes",
    "api.max_query_parameters": "maxQueryParameters",
    "security.rate_limit_enabled": "rateLimitEnabled",
    "security.rate_limit_per_minute": "rateLimitPerMinute",
    "security.rate_limit_sign_in_per_minute": "signInPerMinute",
    "security.cors_enabled": "corsEnabled",
    "security.cors_origins": "corsOrigins",
  };
  return { get: (async (key: SettingKey) => values[keys[key]!]) as HardeningSettingsSource["get"] };
}

async function buildTestApp(settings: HardeningSettings) {
  const app = Fastify({ bodyLimit: FASTIFY_BODY_LIMIT_CEILING, querystringParser: parseQueryString });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TotalBaseError) {
      reply.code(error.httpStatus).send({ errors: [error.toPublicJSON()] });
      return;
    }
    reply.code(500).send({ errors: [{ source: "TOTALBASE", code: "INTERNAL_ERROR", message: "Internal server error." }] });
  });
  registerHardeningHooks(app, sourceOf(settings));
  app.get("/api/ping", async () => ({ ok: true }));
  app.post("/mcp", async () => ({ ok: true }));
  app.post("/api/echo", async (request) => ({ size: JSON.stringify(request.body).length }));
  // A sign-in route: the password "right" signs in, anything else is refused.
  app.post<{ Body: { password?: string } }>("/api/auth/login", async (request, reply) =>
    request.body?.password === "right" ? { data: {} } : reply.code(401).send({ errors: [{ code: "INVALID_CREDENTIALS" }] }));
  await app.ready();
  return app;
}

describe("registerHardeningHooks", () => {
  it("counts failed sign-ins per IP - never a correct one - and refuses past security.rate_limit_sign_in_per_minute", async () => {
    const settings = baseSettings();
    const app = await buildTestApp(settings);
    const login = (password: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { password } });
    for (let i = 0; i < 5; i++) expect((await login("right")).statusCode).toBe(200);
    expect((await login("wrong")).statusCode).toBe(401);
    expect((await login("wrong")).statusCode).toBe(401);
    const refused = await login("right");
    expect(refused.statusCode).toBe(429);
    expect(refused.json().errors[0].code).toBe("RATE_LIMIT_EXCEEDED");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // Another route of the same IP is the general limit's, not this one's.
    expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(200);
    await app.close();
  });

  it("counts no failed sign-in while rate limiting is off - its default", async () => {
    const app = await buildTestApp(baseSettings({ rateLimitEnabled: false }));
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong" } })).statusCode).toBe(401);
    await app.close();
  });

  it("allows requests under the per-minute rate limit and returns 429 with RATE_LIMIT_EXCEEDED past it", async () => {
    const app = await buildTestApp(baseSettings({ rateLimitPerMinute: 3 }));
    try {
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: "GET", url: "/api/ping" });
        expect(res.statusCode).toBe(200);
      }
      const blocked = await app.inject({ method: "GET", url: "/api/ping" });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().errors[0].code).toBe("RATE_LIMIT_EXCEEDED");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it("counts /mcp with a token only against the token's own limit - never the API's per-IP one", async () => {
    const app = await buildTestApp(baseSettings({ rateLimitPerMinute: 2 }));
    try {
      const bearer = { authorization: "Bearer tb_some-token" };
      for (let i = 0; i < 5; i++) expect((await app.inject({ method: "POST", url: "/mcp", headers: bearer })).statusCode).toBe(200);
      // The API's own bucket is untouched by those five; an anonymous /mcp counts there like any request.
      expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/mcp" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/mcp" })).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("does not rate-limit at all when security.rate_limit_enabled is false", async () => {
    const app = await buildTestApp(baseSettings({ rateLimitEnabled: false, rateLimitPerMinute: 1 }));
    try {
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ method: "GET", url: "/api/ping" });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized query string with QUERY_STRING_TOO_LARGE", async () => {
    const app = await buildTestApp(baseSettings({ maxQueryStringBytes: 10 }));
    try {
      const res = await app.inject({ method: "GET", url: `/api/ping?x=${"a".repeat(50)}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("QUERY_STRING_TOO_LARGE");
    } finally {
      await app.close();
    }
  });

  it("rejects too many query parameters with QUERY_PARAMETER_LIMIT_EXCEEDED", async () => {
    const app = await buildTestApp(baseSettings({ maxQueryParameters: 2 }));
    try {
      const res = await app.inject({ method: "GET", url: "/api/ping?a=1&b=2&c=3" });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("QUERY_PARAMETER_LIMIT_EXCEEDED");
    } finally {
      await app.close();
    }
  });

  it("reflects an allowed CORS origin and omits the header for a disallowed one", async () => {
    const app = await buildTestApp(baseSettings());
    try {
      const allowed = await app.inject({ method: "GET", url: "/api/ping", headers: { origin: "https://allowed.example.com" } });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");

      const disallowed = await app.inject({ method: "GET", url: "/api/ping", headers: { origin: "https://evil.example.com" } });
      expect(disallowed.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("never reflects an Origin when CORS is disabled", async () => {
    const app = await buildTestApp(baseSettings({ corsEnabled: false }));
    try {
      const res = await app.inject({ method: "GET", url: "/api/ping", headers: { origin: "https://allowed.example.com" } });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("answers an OPTIONS preflight directly without reaching the route handler", async () => {
    const app = await buildTestApp(baseSettings());
    try {
      const res = await app.inject({ method: "OPTIONS", url: "/api/ping", headers: { origin: "https://allowed.example.com" } });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
    } finally {
      await app.close();
    }
  });

  it("allows Idempotency-Key in a CORS preflight", async () => {
    const app = await buildTestApp(baseSettings());
    try {
      const res = await app.inject({ method: "OPTIONS", url: "/api/ping", headers: { origin: "https://allowed.example.com" } });
      expect(String(res.headers["access-control-allow-headers"]).split(", ")).toContain("idempotency-key");
    } finally {
      await app.close();
    }
  });

  it("rejects a body over api.max_body_bytes with 413 REQUEST_BODY_TOO_LARGE, declared or streamed", async () => {
    const app = await buildTestApp(baseSettings({ maxBodyBytes: 100 }));
    try {
      const small = await app.inject({ method: "POST", url: "/api/echo", payload: { a: "x" } });
      expect(small.statusCode).toBe(200);

      const declared = await app.inject({ method: "POST", url: "/api/echo", payload: { a: "x".repeat(500) } });
      expect(declared.statusCode).toBe(413);
      expect(declared.json().errors[0].code).toBe("REQUEST_BODY_TOO_LARGE");

      // No Content-Length (a stream): cut off as it arrives.
      const streamed = await app.inject({
        method: "POST",
        url: "/api/echo",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        payload: Readable.from([Buffer.from(`{"a":"${"x".repeat(500)}"}`)]),
      });
      expect(streamed.statusCode).toBe(413);
      expect(streamed.json().errors[0].code).toBe("REQUEST_BODY_TOO_LARGE");
    } finally {
      await app.close();
    }
  });

  describe("settings changed while the server runs apply to the next request", () => {
    it("CORS origins and the switch", async () => {
      const settings = baseSettings({ corsOrigins: [] });
      const app = await buildTestApp(settings);
      try {
        const origin = "https://later.example.com";
        const before = await app.inject({ method: "GET", url: "/api/ping", headers: { origin } });
        expect(before.headers["access-control-allow-origin"]).toBeUndefined();
        settings.corsOrigins = [origin];
        const after = await app.inject({ method: "GET", url: "/api/ping", headers: { origin } });
        expect(after.headers["access-control-allow-origin"]).toBe(origin);
        settings.corsEnabled = false;
        const off = await app.inject({ method: "GET", url: "/api/ping", headers: { origin } });
        expect(off.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("the rate limit and its switch", async () => {
      const settings = baseSettings({ rateLimitPerMinute: 100 });
      const app = await buildTestApp(settings);
      try {
        for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(200);
        settings.rateLimitPerMinute = 3;
        expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(429);
        settings.rateLimitEnabled = false;
        expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("the body, query string and parameter limits", async () => {
      const settings = baseSettings();
      const app = await buildTestApp(settings);
      try {
        expect((await app.inject({ method: "POST", url: "/api/echo", payload: { a: "x".repeat(500) } })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: "/api/ping?a=1&b=2&c=3" })).statusCode).toBe(200);
        settings.maxBodyBytes = 100;
        settings.maxQueryParameters = 2;
        expect((await app.inject({ method: "POST", url: "/api/echo", payload: { a: "x".repeat(500) } })).statusCode).toBe(413);
        expect((await app.inject({ method: "GET", url: "/api/ping?a=1&b=2&c=3" })).json().errors[0].code).toBe("QUERY_PARAMETER_LIMIT_EXCEEDED");
        settings.maxQueryStringBytes = 5;
        expect((await app.inject({ method: "GET", url: "/api/ping?a=123456" })).json().errors[0].code).toBe("QUERY_STRING_TOO_LARGE");
      } finally {
        await app.close();
      }
    });
  });
});

describe("parseQueryString", () => {
  const orOf = (n: number) => Array.from({ length: n }, (_, i) => `where[_or][${i}][name][_eq]=n${i}`).join("&");

  it("keeps a long list a list - qs's default turned a 21st item into an object keyed by index", () => {
    const parsed = parseQueryString(orOf(25)) as { where: { _or: unknown[] } };
    expect(Array.isArray(parsed.where._or)).toBe(true);
    expect(parsed.where._or).toHaveLength(25);
    expect(parsed.where._or[24]).toEqual({ name: { _eq: "n24" } });
  });

  it("keeps deep nesting as nesting - qs's default made a sixth bracket level a literal key", () => {
    const parsed = parseQueryString("where[_or][0][_and][0][_not][name][_eq]=x") as Record<string, any>;
    expect(parsed.where._or[0]._and[0]._not).toEqual({ name: { _eq: "x" } });
  });

  it("refuses past its bounds with the stable errors, as an HTTP 400", async () => {
    const app = await buildTestApp(baseSettings({ maxQueryParameters: 10_000, maxQueryStringBytes: 1_000_000 }));
    try {
      const pairs = await app.inject({ method: "GET", url: `/api/ping?${orOf(QUERY_STRING_PAIR_LIMIT + 1)}` });
      expect([pairs.statusCode, pairs.json().errors[0].code]).toEqual([400, "QUERY_PARAMETER_LIMIT_EXCEEDED"]);
      const deep = await app.inject({ method: "GET", url: `/api/ping?a${"[x]".repeat(QUERY_STRING_DEPTH_LIMIT + 1)}=1` });
      expect([deep.statusCode, deep.json().errors[0].code]).toEqual([400, "QUERY_DEPTH_LIMIT_EXCEEDED"]);
    } finally {
      await app.close();
    }
  });
});
