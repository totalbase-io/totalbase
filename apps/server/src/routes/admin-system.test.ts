import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { adminToken, setupTestApp } from "../test-support.js";
import { TOTALBASE_VERSION } from "../version.js";

/** Settings > General > General's "About this instance", and the version the account menu shows (Administration.md §7.10). */
describe("GET /admin/api/system", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let token: string;

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    token = await adminToken(context);
  });

  afterAll(async () => {
    await app.close();
  });

  it("tells this build's version, the environment and the PostgreSQL it runs on", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/system", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.version).toBe(TOTALBASE_VERSION);
    expect(data.environment).toBe(context.nodeEnv);
    // "17.2", "15.14": the server's version without the build's suffix.
    expect(data.postgres.version).toMatch(/^\d+\.\d+/);
    expect(data.postgres.database).toBe((await context.database.query<{ db: string }>("SELECT current_database() AS db")).rows[0]!.db);
  });

  it("rides the version with the signed-in account, like the environment", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.version).toBe(TOTALBASE_VERSION);
  });
});
