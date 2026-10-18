import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp } from "./test-support.js";

/**
 * An unknown /admin/api/* path must answer as an API 404 - never fall
 * through to the admin UI handlers (in dev, a proxy loop between this
 * server and `nuxt dev` that hung every /admin/* request; in prod, the
 * SPA's index.html with a 200).
 */
describe("admin UI routing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers an unknown Admin API path with a JSON 404", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/auth/invitations/accept" });
    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].code).toBe("RESOURCE_NOT_FOUND");
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
    const res = await app.inject({ method: "GET", url: "/admin/_icons/lucide.json?icons=store,receipt,not-an-icon" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("max-age");
    const body = res.json();
    expect(body.prefix).toBe("lucide");
    expect(Object.keys(body.icons).sort()).toEqual(["receipt", "store"]);
    expect(body.icons.store.body).toContain("<");
    expect(body.not_found).toEqual(["not-an-icon"]);
  });

  it("rejects an unknown collection and malformed icon names", async () => {
    const collection = await app.inject({ method: "GET", url: "/admin/_icons/mdi.json?icons=home" });
    expect(collection.statusCode).toBe(404);
    const names = await app.inject({ method: "GET", url: "/admin/_icons/lucide.json?icons=../etc/passwd" });
    expect(names.statusCode).toBe(400);
    const none = await app.inject({ method: "GET", url: "/admin/_icons/lucide.json" });
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
