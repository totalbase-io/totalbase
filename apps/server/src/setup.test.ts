import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { resolveSetup, setupCodeMatches } from "./setup.js";
import { setupTestApp } from "./test-support.js";

/**
 * The first-start setup (Foundations.md §14.1). The test database has an administrator, so creating one is
 * covered by the image's own run; here: the code's checks, the attempts limit, and that an instance with an
 * administrator never offers a setup.
 */
describe("the first-start setup", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let dir: string;
  const logger = pino({ level: "silent" });
  const post = (code: string) => app.inject({ method: "POST", url: "/api/setup", payload: { data: { code, email: "setup-test@example.com", password: "a-strong-enough-password" } } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    dir = await mkdtemp(join(tmpdir(), "totalbase-setup-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await app.close();
    await database.close();
  });

  it("an instance with an administrator has no setup: no code, the file removed, 404", async () => {
    await writeFile(join(dir, "setup-code"), "LEFT-OVER-CODE-0000\n");
    const state = await resolveSetup(database, undefined, dir, logger, "http://localhost:3030");
    expect(state.code).toBeNull();
    await expect(stat(join(dir, "setup-code"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await app.inject({ method: "GET", url: "/api/setup" })).json().data).toEqual({ required: false });
    expect((await post("ANY-CODE-AT-ALL-0000")).statusCode).toBe(404);
  });

  it("compares codes in any case and with or without dashes, and nothing else", () => {
    const state = { code: "K7QP-M2XD-9WFA-H4TN", source: "GENERATED" as const, file: "" };
    expect(setupCodeMatches(state, "k7qpm2xd9wfah4tn")).toBe(true);
    expect(setupCodeMatches(state, "K7QP-M2XD-9WFA-H4TM")).toBe(false);
    expect(setupCodeMatches(state, undefined)).toBe(false);
    expect(setupCodeMatches({ ...state, code: null }, "K7QP-M2XD-9WFA-H4TN")).toBe(false);
  });

  it("a wrong code is refused, and after ten wrong ones even the right one waits", async () => {
    context.setup.code = "K7QP-M2XD-9WFA-H4TN";
    expect((await app.inject({ method: "GET", url: "/api/setup" })).json().data).toEqual({ required: true });
    const wrong = await post("AAAA-BBBB-CCCC-DDDD");
    expect([wrong.statusCode, wrong.json().errors?.[0]?.code]).toEqual([403, "INVALID_SETUP_CODE"]);
    for (let i = 0; i < 9; i++) await post("AAAA-BBBB-CCCC-DDDD");
    expect((await post("K7QP-M2XD-9WFA-H4TN")).statusCode).toBe(429);
  });

  it("never reads TOTALBASE_SETUP_CODE once an administrator exists - not even to check it", async () => {
    await expect(resolveSetup(database, "short", dir, logger, "http://localhost:3030")).resolves.toMatchObject({ code: null });
  });
});
