import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

/** An id in the path that can't be one is a 404, like one that matches nothing - never PostgreSQL's 400 (Data_API.md §2.4). */
describe("path ids", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: "GET" | "PUT", url: string) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` }, ...(method === "PUT" ? { payload: { data: {} } } : {}) });
  const get = (url: string) => call("GET", url);

  it.each([
    ["GET", "/admin/api/roles/not-a-uuid/incompatible"],
    ["GET", "/admin/api/dashboards/42"],
    ["GET", "/admin/api/workflows/runs/x"],
    ["PUT", "/admin/api/roles/x/managers"],
  ] as const)("answers 404 for %s %s", async (method, url) => {
    const res = await call(method, url);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().errors[0].code).toBe("ROW_NOT_FOUND");
  });

  it("still answers 401 first to a caller without a token", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/api/dashboards/42" })).statusCode).toBe(401);
  });

  it("leaves a well-formed id to the route", async () => {
    const res = await get("/admin/api/dashboards/00000000-0000-0000-0000-000000000000");
    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].code).toBe("DASHBOARD_NOT_FOUND");
  });
});
