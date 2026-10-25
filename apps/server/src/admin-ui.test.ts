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
    for (const url of ["/", "/status", "/app/dataviews/orders?view=1", "/admin", "/embed/tbe_x"]) {
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
 * A malformed request (bad JSON, an empty body declared as JSON) is the
 * caller's mistake: Fastify's own 4xx, never a 500 INTERNAL_ERROR.
 */
describe("request parsing errors", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers an empty JSON body and malformed JSON with a 400", async () => {
    const empty = await app.inject({
      method: "DELETE",
      url: "/admin/api/roles/00000000-0000-0000-0000-000000000000",
      headers: { "content-type": "application/json" },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().errors[0].code).toBe("INVALID_QUERY");

    const malformed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);
  });
});
