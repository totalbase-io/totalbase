import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, redactedUrl } from "./server.js";
import { setupTestApp } from "./test-support.js";

/**
 * The server's paths and the SPA's (Foundations.md §4.1): the SPA at the
 * root, a real built file as is and any other GET its index.html; an
 * unknown path under a reserved prefix an API 404 - never the SPA's page
 * (in dev, a proxy loop between this server and `nuxt dev`; in prod, the
 * index.html with a 200); anything else nothing answers the same JSON 404.
 */
describe("routing: the server's paths and the SPA's", () => {
  let app: FastifyInstance;
  let spa: FastifyInstance;
  let apiOnly: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    let context;
    ({ app, context } = await setupTestApp());
    dir = mkdtempSync(join(tmpdir(), "totalbase-spa-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa</title>");
    mkdirSync(join(dir, "_nuxt"));
    writeFileSync(join(dir, "_nuxt", "entry.js"), "export {}");
    spa = await buildServer(context, "silent", { enabled: true, dir });
    apiOnly = await buildServer(context, "silent", { enabled: false });
    await Promise.all([spa.ready(), apiOnly.ready()]);
  });

  afterAll(async () => {
    await Promise.all([spa?.close(), apiOnly?.close(), app?.close()]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the SPA at the root: its files as they are, any other GET its index.html", async () => {
    for (const url of ["/", "/status", "/app/dataviews/orders?view=1", "/settings", "/embed/tbe_x"]) {
      const res = await spa.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain("<title>spa</title>");
    }
    const asset = await spa.inject({ method: "GET", url: "/_nuxt/entry.js" });
    expect(asset.body).toBe("export {}");
    expect((await spa.inject({ method: "GET", url: "/status" })).headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  });

  it("never logs a public embed's key, its path - the embed API's paths are no key", () => {
    expect(redactedUrl("/embed/tbe_secret?x=1")).toBe("/embed/[redacted]");
    expect(redactedUrl("/embed/api/dashboard?token=t")).toBe("/embed/api/dashboard");
  });

  it("redirects /admin - where other tools keep their admin - to the root, the admin itself", async () => {
    for (const url of ["/admin", "/admin/"]) {
      const res = await spa.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(301);
      expect(res.headers.location, url).toBe("/");
    }
    expect((await spa.inject({ method: "GET", url: "/admin/status" })).statusCode).toBe(200);
    expect((await apiOnly.inject({ method: "GET", url: "/admin" })).statusCode).toBe(404);
  });

  it("answers an unknown path under a reserved prefix with a JSON 404, never the SPA", async () => {
    for (const url of ["/api/nope", "/admin/api/nope", "/app/api/nope", "/embed/api/nope", "/health/nope"]) {
      for (const method of ["GET", "POST"] as const) {
        const res = await spa.inject({ method, url, headers: { accept: "text/html" } });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json().errors[0].code, `${method} ${url}`).toBe("RESOURCE_NOT_FOUND");
      }
    }
  });

  it("answers what nothing serves with the same JSON 404: another method on an SPA path, any path API-only", async () => {
    const post = await spa.inject({ method: "POST", url: "/status" });
    expect(post.statusCode).toBe(404);
    expect(post.json().errors[0].code).toBe("RESOURCE_NOT_FOUND");
    for (const url of ["/", "/status"]) {
      const res = await apiOnly.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().errors[0].code, url).toBe("RESOURCE_NOT_FOUND");
    }
  });
});

/**
 * The admin UI's icons come from this server (admin-icons.ts), never from
 * api.iconify.design - in the Iconify API's format Nuxt Icon reads.
 */
describe("admin icons", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers the requested lucide icons, listing unknown names in not_found", async () => {
    const res = await app.inject({ method: "GET", url: "/_icons/lucide.json?icons=store,receipt,not-an-icon" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("max-age");
    const body = res.json();
    expect(body.prefix).toBe("lucide");
    expect(Object.keys(body.icons).sort()).toEqual(["receipt", "store"]);
    expect(body.icons.store.body).toContain("<");
    expect(body.not_found).toEqual(["not-an-icon"]);
  });

  it("rejects an unknown collection and malformed icon names", async () => {
    const collection = await app.inject({ method: "GET", url: "/_icons/mdi.json?icons=home" });
    expect(collection.statusCode).toBe(404);
    const names = await app.inject({ method: "GET", url: "/_icons/lucide.json?icons=../etc/passwd" });
    expect(names.statusCode).toBe(400);
    const none = await app.inject({ method: "GET", url: "/_icons/lucide.json" });
    expect(none.statusCode).toBe(400);
  });
});

/**
 * Malformed JSON is the caller's mistake: Fastify's own 4xx, never a 500 INTERNAL_ERROR. An empty body is no
 * body, whatever Content-Type the client sends with every request (Data_API.md §2.4).
 */
describe("request parsing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it("takes an empty body declared as JSON as no body", async () => {
    const url = "/admin/api/roles/00000000-0000-0000-0000-000000000000";
    const plain = await app.inject({ method: "DELETE", url });
    for (const contentType of ["application/json", "application/json; charset=utf-8"]) {
      const declared = await app.inject({ method: "DELETE", url, headers: { "content-type": contentType } });
      expect(declared.statusCode).toBe(plain.statusCode);
      expect(declared.json()).toEqual(plain.json());
    }
    expect(plain.statusCode).not.toBe(400);

    // A route that needs a body refuses it as it does one sent without a Content-Type - never a 500
    // (password/forgot answers 204 whatever it is sent).
    const needBody = [
      "/api/auth/login", "/admin/api/auth/login", "/api/auth/register", "/api/auth/password/forgot", "/api/auth/password/reset",
      "/api/auth/password/change", "/api/auth/email/verify", "/api/auth/invitations/accept", "/api/auth/mfa/verify", "/api/auth/password/renew", "/api/transactions",
    ];
    for (const route of needBody) {
      const declared = await app.inject({ method: "POST", url: route, headers: { "content-type": "application/json" } });
      const bare = await app.inject({ method: "POST", url: route });
      expect(declared.statusCode, route).toBe(bare.statusCode);
      expect(declared.statusCode, `${route} ${declared.body}`).toBeLessThan(500);
    }
  });

  it("answers malformed JSON with a 400", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      // An address of its own: the suite's other refused sign-ins count against 127.0.0.1 (security.rate_limit_sign_in_per_minute).
      remoteAddress: "203.0.113.41",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().errors[0].code).toBe("INVALID_QUERY");
  });

  it("still refuses a prototype-poisoning body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      // An address of its own: the suite's other refused sign-ins count against 127.0.0.1 (security.rate_limit_sign_in_per_minute).
      remoteAddress: "203.0.113.41",
      headers: { "content-type": "application/json" },
      payload: '{"__proto__":{"admin":true}}',
    });
    expect(res.statusCode).toBe(400);
  });
});
