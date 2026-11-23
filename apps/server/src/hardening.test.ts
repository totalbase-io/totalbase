import { Readable } from "node:stream";
import Fastify from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingKey } from "@totalbase/settings";
import { describe, expect, it } from "vitest";
import {
  credentialBucket,
  CredentialOwners,
  FASTIFY_BODY_LIMIT_CEILING,
  QUERY_STRING_DEPTH_LIMIT,
  QUERY_STRING_PAIR_LIMIT,
  parseQueryString,
  RateLimiter,
  refusedBucket,
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
  perUserPerMinute: number;
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
    perUserPerMinute: 2,
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
    "security.rate_limit_per_user_per_minute": "perUserPerMinute",
    "security.cors_enabled": "corsEnabled",
    "security.cors_origins": "corsOrigins",
  };
  return { get: (async (key: SettingKey) => values[keys[key]!]) as HardeningSettingsSource["get"] };
}

async function buildTestApp(settings: HardeningSettings, options: { trustProxy?: boolean } = {}) {
  const app = Fastify({ bodyLimit: FASTIFY_BODY_LIMIT_CEILING, routerOptions: { querystringParser: parseQueryString }, trustProxy: options.trustProxy ?? false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TotalBaseError) {
      reply.code(error.httpStatus).send({ errors: [error.toPublicJSON()] });
      return;
    }
    reply.code(500).send({ errors: [{ source: "TOTALBASE", code: "INTERNAL_ERROR", message: "Internal server error." }] });
  });
  registerHardeningHooks(app, sourceOf(settings));
  app.get("/api/ping", async () => ({ ok: true }));
  // A credentialed route: the bearer "good..." is a credential that resolves - its user told to the limiter, as the
  // session and token services do (onValidated) - anything else is refused.
  app.get("/api/mine", async (request, reply) => {
    const token = (request.headers.authorization ?? "").match(/^Bearer (good\S*)/)?.[1];
    if (!token) return reply.code(401).send({ errors: [{ code: "AUTHENTICATION_REQUIRED" }] });
    // "good-a@user-1" is user-1's; a token without a user is its own.
    app.credentialOwners!.remember(token, token.split("@")[1] ?? `user-of-${token}`);
    return { ok: true };
  });
  app.post("/mcp", async () => ({ ok: true }));
  app.post("/api/echo", async (request) => ({ size: JSON.stringify(request.body).length }));
  app.post("/api/auth/password/forgot", { config: { public: true } }, async (_request, reply) => reply.code(204).send());
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

  // Under the per-address switch, off by default, the limit was off too: guesses across accounts from one address met
  // only each account's lockout (an external tester's report against beta.14).
  it("counts failed sign-ins with the per-address limit off too - not through a proxy it doesn't trust, and not at 0", async () => {
    const wrong = (app: Awaited<ReturnType<typeof buildTestApp>>, headers: Record<string, string> = {}, remoteAddress?: string) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong" }, headers, ...(remoteAddress && { remoteAddress }) });
    const off = await buildTestApp(baseSettings({ rateLimitEnabled: false }));
    expect((await wrong(off)).statusCode).toBe(401);
    expect((await wrong(off)).statusCode).toBe(401);
    expect((await wrong(off)).statusCode).toBe(429);
    // Through an untrusted proxy every caller has its address: anyone's failures would refuse everyone's sign-in.
    for (let i = 0; i < 4; i++) expect((await wrong(off, { "x-forwarded-for": "198.51.100.7" }, "10.0.0.5")).statusCode).toBe(401);
    // A caller from outside saying it's forwarded is counted all the same.
    for (let i = 0; i < 2; i++) expect((await wrong(off, { "x-forwarded-for": "198.51.100.7" }, "203.0.113.9")).statusCode).toBe(401);
    expect((await wrong(off, { "x-forwarded-for": "198.51.100.7" }, "203.0.113.9")).statusCode).toBe(429);
    await off.close();
    const zero = await buildTestApp(baseSettings({ rateLimitEnabled: false, signInPerMinute: 0 }));
    for (let i = 0; i < 4; i++) expect((await wrong(zero)).statusCode).toBe(401);
    await zero.close();
    // With the per-address limit on, the proxy's address is counted as it is.
    const on = await buildTestApp(baseSettings());
    for (let i = 0; i < 2; i++) expect((await wrong(on, { "x-forwarded-for": "198.51.100.7" }, "10.0.0.5")).statusCode).toBe(401);
    expect((await wrong(on, { "x-forwarded-for": "198.51.100.7" }, "10.0.0.5")).statusCode).toBe(429);
    await on.close();
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

  it("counts a request with a credential in that credential's bucket, never the address's; a refused credential counts against the address", async () => {
    const app = await buildTestApp(baseSettings({ rateLimitPerMinute: 4, perUserPerMinute: 2 }));
    try {
      const mine = (token: string) => app.inject({ method: "GET", url: "/api/mine", headers: { authorization: `Bearer ${token}` } });
      // Two credentials from one address: two buckets of perUserPerMinute each, the address's untouched. A
      // credential's first request, before its user is known, isn't counted.
      expect((await mine("good-a")).statusCode).toBe(200);
      expect((await mine("good-a")).statusCode).toBe(200);
      expect((await mine("good-a")).statusCode).toBe(200);
      const third = await mine("good-a");
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
      expect((await mine("good-b")).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(200);

      // Invented credentials: each is refused (401) and counted against the address, whose bucket (3) then
      // refuses everything from it - a flood of made-up tokens opens no fresh buckets (the anonymous ping above took one).
      for (const token of ["bad-1", "bad-2", "bad-3"]) expect((await mine(token)).statusCode).toBe(401);
      expect((await mine("bad-4")).statusCode).toBe(429);
      expect((await mine("good-b")).statusCode).toBe(429);
      expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("limits each user's requests whatever security.rate_limit_enabled says - only 0 turns it off", async () => {
    const settings = baseSettings({ rateLimitEnabled: false, rateLimitPerMinute: 1, perUserPerMinute: 2 });
    const app = await buildTestApp(settings);
    try {
      const mine = () => app.inject({ method: "GET", url: "/api/mine", headers: { authorization: "Bearer good-a" } });
      expect((await mine()).statusCode).toBe(200);
      expect((await mine()).statusCode).toBe(200);
      expect((await mine()).statusCode).toBe(200);
      expect((await mine()).statusCode).toBe(429);
      // The address's limit is off: anonymous requests run free.
      for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(200);
      settings.perUserPerMinute = 0;
      expect((await mine()).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("counts every credential of one user in one bucket once it has validated", async () => {
    const app = await buildTestApp(baseSettings({ perUserPerMinute: 3 }));
    try {
      const mine = (token: string) => app.inject({ method: "GET", url: "/api/mine", headers: { authorization: `Bearer ${token}` } });
      app.credentialOwners!.remember("good-a@user-1", "user-1");
      app.credentialOwners!.remember("good-b@user-1", "user-1");
      expect((await mine("good-a@user-1")).statusCode).toBe(200);
      expect((await mine("good-b@user-1")).statusCode).toBe(200);
      expect((await mine("good-a@user-1")).statusCode).toBe(200);
      expect((await mine("good-b@user-1")).statusCode).toBe(429);
      // Another user's credential has a bucket of its own.
      app.credentialOwners!.remember("good-c@user-2", "user-2");
      expect((await mine("good-c@user-2")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // Security regression (round 11, SEC-114): with the per-address limit off (the default), a credential no validation
  // vouched for opened a bucket of its own - a random bearer per request, a window each, memory without a bound.
  it("opens no bucket for a credential that never validated", () => {
    const limiter = new RateLimiter();
    const owners = new CredentialOwners();
    for (let i = 0; i < 1000; i++) {
      const credential = credentialBucket(`invented-${i}`);
      expect(refusedBucket(limiter, owners, { ip: "203.0.113.9", credential, enabled: false, perMinute: 3000, perUserPerMinute: 1200 })).toBeNull();
    }
    expect(limiter.size).toBe(0);
  });

  // Security regression (round 11, SEC-113): a WebSocket opened with a ticket reported its session's id, and the id
  // mapped to the user's bucket like a token - but an id isn't a secret: whoever read it sent it as a bearer and
  // spent its owner's limit, every session and token of theirs refused with 429.
  it("never lets a session's id, presented as a bearer, spend its owner's limit", async () => {
    const app = await buildTestApp(baseSettings({ perUserPerMinute: 2 }));
    try {
      const mine = (token: string) => app.inject({ method: "GET", url: "/api/mine", headers: { authorization: `Bearer ${token}` } });
      app.credentialOwners!.remember("session-id-1", "user-1", "SESSION_ID");
      app.credentialOwners!.remember("good-a@user-1", "user-1");
      for (let i = 0; i < 3; i++) await mine("session-id-1");
      expect((await mine("good-a@user-1")).statusCode).toBe(200);
      expect((await mine("good-a@user-1")).statusCode).toBe(200);
      expect((await mine("good-a@user-1")).statusCode).toBe(429);
      // The socket holding the id is still counted on its user.
      await expect(app.operationRateLimit!("127.0.0.1", { session: "session-id-1" })).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    } finally {
      await app.close();
    }
  });

  it("notices a request forwarded by a private-network proxy the server doesn't trust - not one it trusts", async () => {
    const untrusted = await buildTestApp(baseSettings());
    const trusted = await buildTestApp(baseSettings(), { trustProxy: true });
    try {
      await untrusted.inject({ method: "GET", url: "/api/ping" });
      expect(untrusted.untrustedProxySeenAt).toBeNull();
      await untrusted.inject({ method: "GET", url: "/api/ping", headers: { "x-forwarded-for": "203.0.113.7" } });
      expect(untrusted.untrustedProxySeenAt).toBeGreaterThan(0);
      await trusted.inject({ method: "GET", url: "/api/ping", headers: { "x-forwarded-for": "203.0.113.7" } });
      expect(trusted.untrustedProxySeenAt).toBeNull();
    } finally {
      await untrusted.close();
      await trusted.close();
    }
  });

  it("does not limit anonymous requests per address when security.rate_limit_enabled is false", async () => {
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

  // Security regression (Security.md §2.8): a public route never checks a credential, so an invented `Bearer` per
  // request opened a fresh bucket each time - a reset request, registration or verification resend met no limit.
  it("counts a public route's requests against the address, whatever credential they carry", async () => {
    const app = await buildTestApp(baseSettings({ rateLimitPerMinute: 3, perUserPerMinute: 100 }));
    try {
      for (let i = 0; i < 3; i++) {
        expect((await app.inject({ method: "POST", url: "/api/auth/password/forgot", headers: { authorization: `Bearer invented-${i}` }, payload: {} })).statusCode).toBe(204);
      }
      expect((await app.inject({ method: "POST", url: "/api/auth/password/forgot", headers: { authorization: "Bearer invented-again" }, payload: {} })).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  // The router decodes a path before matching it: `/%61pi/ping` is `/api/ping`. Every guard decides on the route
  // reached, never on the raw request target - which starts with `/%61pi` (Foundations.md §4.1).
  describe("a percent-encoded path is held to the guards of the route it reaches", () => {
    const ENCODED = ["/%61pi/ping", "/ap%69/ping", "/api/p%69ng", "/%61pi/nowhere"];

    it("counts it in the rate limit, matched or not", async () => {
      const app = await buildTestApp(baseSettings({ rateLimitPerMinute: ENCODED.length }));
      try {
        for (const url of ENCODED) expect((await app.inject({ method: "GET", url })).statusCode, url).not.toBe(429);
        expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(429);
      } finally {
        await app.close();
      }
    });

    it("counts a failed sign-in on it", async () => {
      const app = await buildTestApp(baseSettings());
      try {
        for (const url of ["/%61pi/auth/login", "/api/auth/l%6Fgin"]) {
          expect((await app.inject({ method: "POST", url, payload: { password: "wrong" } })).statusCode, url).toBe(401);
        }
        expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "right" } })).statusCode).toBe(429);
      } finally {
        await app.close();
      }
    });

    it("holds a cookie-authenticated write on it to the same origin", async () => {
      const app = await buildTestApp(baseSettings());
      try {
        for (const url of ["/api/echo", "/%61pi/echo"]) {
          const response = await app.inject({ method: "POST", url, headers: { cookie: "tb_session=abc", "sec-fetch-site": "cross-site" }, payload: {} });
          expect([response.statusCode, response.json().errors?.[0]?.code], url).toEqual([403, "CROSS_SITE_REQUEST_REFUSED"]);
        }
      } finally {
        await app.close();
      }
    });

    it("holds it to the query-string limits", async () => {
      const app = await buildTestApp(baseSettings({ maxQueryParameters: 2 }));
      try {
        expect((await app.inject({ method: "GET", url: "/%61pi/ping?a=1&b=2&c=3" })).json().errors?.[0]?.code).toBe("QUERY_PARAMETER_LIMIT_EXCEEDED");
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
