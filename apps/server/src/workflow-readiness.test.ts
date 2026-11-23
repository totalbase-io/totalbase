import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { publishAdvisories, validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/** Publish readiness (Workflows.md §10.2): every issue at once, each in the editor's words. */
describe("workflow publish readiness", () => {
  let app: FastifyInstance;
  let context: AppContext;

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const op = (key: string, type: string, configuration: Record<string, unknown> = {}) => ({ id: randomUUID(), key, type, configuration_version: 1, label: key, configuration });
  const link = (source: { id: string }, target: { id: string }, output = "next") => ({ source: source.id, target: target.id, output });
  const issuesOf = async (definition: Record<string, unknown>): Promise<string[]> => {
    try {
      await validateExecutionReadiness(definition, context);
      return [];
    } catch (error) {
      expect((error as { code?: string }).code).toBe("WORKFLOW_NOT_PUBLISHABLE");
      return (error as Error).message.split("\n");
    }
  };

  it("passes a complete definition - a step after a loop may read the loop's body", async () => {
    const start = op("start", "totalbase.start", { trigger: "MANUAL" });
    const loop = op("loop", "totalbase.for-each", { items: "{{start.data.list}}" });
    const body = op("double", "totalbase.execute-javascript", { code: "return item * 2", input: "{{item}}" });
    const finish = op("finish", "totalbase.finish-result", { result: "{{double.data}}" });
    expect(await issuesOf({ operations: [start, loop, body, finish], connections: [link(start, loop), link(loop, body, "item"), link(loop, finish, "done")] })).toEqual([]);
  });

  it("lists every missing piece, forward reference and empty loop together", async () => {
    const start = op("start", "totalbase.start", { trigger: "MANUAL" });
    const email = op("mail", "totalbase.send-email", { to: "", subject: "Hi {{later.data}}" });
    const loop = op("loop", "totalbase.for-each", { items: "{{start.data.list}}" });
    const later = op("later", "totalbase.execute-javascript", { code: "" });
    const finish = op("finish", "totalbase.finish-result", { result: "{{nope.data}}" });
    const issues = await issuesOf({
      operations: [start, email, loop, later, finish],
      connections: [link(start, email), link(email, loop), link(loop, later, "done"), link(later, finish)],
    });
    expect(issues).toEqual(expect.arrayContaining([
      'Step "mail": no recipient.',
      'Step "mail": {{later...}} names a step that doesn\'t run before it.',
      'Step "loop": its loop has no body connected.',
      'Step "later": no code.',
      'Step "finish": {{nope...}} names no step.',
    ]));
  });

  // Found only on a run: a Read records query that fails to parse or names what the table hasn't, and a step in an
  // error branch reading the step that failed ("references a step that hasn't run yet").
  it("checks a Read records query against its table, and a failed step read in its error branch", async () => {
    const { rows } = await context.database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'roles' AND status = 'ACTIVE'`);
    const start = op("start", "totalbase.start", { trigger: "MANUAL" });
    const read = op("read", "totalbase.read-records", { resource: rows[0]!.id, query: { fields: ["id", "name"], sort: "-name", where: { nombre: { _eq: "{{start.data.name}}" } } } });
    const call = op("call", "totalbase.http-request", { method: "GET", url: "https://example.com/{{read.data}}" });
    const warn = op("warn", "totalbase.finish-result", { result: "{{call.error.message}}" });
    const done = op("done", "totalbase.finish-result", { result: "{{call.data}}" });
    const issues = await issuesOf({ operations: [start, read, call, warn, done], connections: [link(start, read), link(read, call), link(call, warn, "error"), link(call, done)] });
    expect(issues).toEqual([
      expect.stringMatching(/^Step "read": its query - Unknown query parameter: sort \(sort -> order_by\)/),
      'Step "warn": {{call...}} runs only after "call" failed, which leaves no result - its error is {{error.message}}.',
    ]);
    read.configuration.query = { fields: ["id", "name"], where: { nombre: { _eq: "x" } } };
    expect((await issuesOf({ operations: [start, read], connections: [link(start, read)] }))[0]).toMatch(/^Step "read": its query - Unknown field: roles\.nombre/);
    read.configuration.query = { fields: "id,name", order_by: "-name", where: { name: { _eq: "{{start.data.name}}" } } };
    warn.configuration.result = "{{error.message}}";
    expect(await issuesOf({ operations: [start, read, call, warn, done], connections: [link(start, read), link(read, call), link(call, warn, "error"), link(call, done)] })).toEqual([]);
  });

  // WF-01: an Update/Delete records `where` that is itself a {{...}} took its grammar from a webhook's body.
  it("checks an Update and a Delete records where like a Read records query - refusing one that is itself a {{...}}", async () => {
    const { rows } = await context.database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'roles' AND status = 'ACTIVE'`);
    const start = op("start", "totalbase.start", { trigger: "MANUAL" });
    for (const type of ["totalbase.update-records", "totalbase.delete-records"]) {
      const step = op("step", type, { resource: rows[0]!.id, where: "{{start.data.where}}", ...(type.includes("update") && { set: { description: "x" } }) });
      expect(await issuesOf({ operations: [start, step], connections: [link(start, step)] }), type).toEqual([expect.stringMatching(/^Step "step": its where - Invalid filter object/)]);
      step.configuration.where = { nombre: { _eq: "{{start.data.id}}" } };
      expect((await issuesOf({ operations: [start, step], connections: [link(start, step)] }))[0], type).toMatch(/^Step "step": its where - Unknown field: roles\.nombre/);
      step.configuration.where = { id: { _eq: "{{start.data.id}}" } };
      expect(await issuesOf({ operations: [start, step], connections: [link(start, step)] }), type).toEqual([]);
    }
  });

  // WF-L1: a public webhook with no secret, no allowed addresses, acting as its Execute as user - advised at publish.
  it("advises on a public webhook anyone with its URL sets off - quiet once it has a secret or allowed addresses", async () => {
    const { rows } = await context.database.query<{ id: string }>(`SELECT a."user" AS id FROM totalbase.users_roles a JOIN totalbase.roles r ON r.id = a.role WHERE r.admin_access LIMIT 1`);
    const start = op("start", "totalbase.start", { trigger: "WEBHOOK", access: "PUBLIC", execute_as: rows[0]!.id });
    const write = op("write", "totalbase.delete-records", { resource: randomUUID(), where: { id: { _eq: "{{start.data.id}}" } } });
    const definition = { operations: [start, write], connections: [link(start, write)] };
    expect(await publishAdvisories(definition, context)).toEqual([expect.stringMatching(/^This webhook is public with no secret and no allowed addresses: anyone who learns its URL runs "write" as an administrator/)]);
    expect(await publishAdvisories({ operations: [start], connections: [] }, context)).toEqual([]);
    start.configuration.allowed_ips = ["10.0.0.0/8"];
    expect(await publishAdvisories(definition, context)).toEqual([]);
    start.configuration = { trigger: "WEBHOOK", access: "PUBLIC", execute_as: rows[0]!.id, secret: "hook_secret" };
    expect(await publishAdvisories(definition, context)).toEqual([]);
  });

  it("refuses a Schedule the dispatcher would skip - expression, time zone and Execute as", async () => {
    const finish = (start: { id: string }) => {
      const end = op("finish", "totalbase.finish-result", { result: "ok" });
      return { operations: [start, end], connections: [link(start, end)] };
    };
    const { rows } = await context.database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE active ORDER BY created_at LIMIT 1`);
    const valid = op("start", "totalbase.start", { trigger: "CRON", cron_expression: "0 9 * * 1-5", timezone: "America/Argentina/Salta", execute_as: rows[0]!.id });
    expect(await issuesOf(finish(valid))).toEqual([]);
    const broken = op("start", "totalbase.start", { trigger: "CRON", cron_expression: "0 25 * * *", timezone: "Mars/Olympus", execute_as: randomUUID() });
    const issues = await issuesOf(finish(broken));
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatch(/^Step "start": its schedule is invalid/);
    expect(issues.slice(1)).toEqual(['Step "start": unknown time zone "Mars/Olympus".', 'Step "start": its "Execute as" user no longer exists or is inactive.']);
    expect(await issuesOf(finish(op("start", "totalbase.start", { trigger: "CRON" })))).toEqual([
      'Step "start": no schedule expression.',
      'Step "start": no time zone.',
      'Step "start": no "Execute as" user.',
    ]);
  });

  // Security regression (round 9): a DATA_EVENT Start filter with $USER.* or $PERIOD.* published, then failed on every
  // matching row - an event retried until it failed for good, every later workflow of it losing its admission.
  it("refuses $USER.* and $PERIOD.* in a data event's filter - nothing resolves them there", async () => {
    const start = op("start", "totalbase.start", { trigger: "DATA_EVENT", resource: randomUUID(), events: ["INSERT"], filter: { owner: { _eq: "$USER.id" } } });
    const end = op("finish", "totalbase.finish-result", { result: "ok" });
    const issues = await issuesOf({ operations: [start, end], connections: [link(start, end)] });
    expect(issues.some((issue) => /can't use \$USER\.\* or \$PERIOD\.\*/.test(issue))).toBe(true);
    // Round 10: also as an item of a list, which the parser splits on commas.
    const listed = op("start", "totalbase.start", { trigger: "DATA_EVENT", resource: randomUUID(), events: ["INSERT"], filter: { status: { _in: "a,$USER.id" } } });
    const listedIssues = await issuesOf({ operations: [listed, end], connections: [link(listed, end)] });
    expect(listedIssues.some((issue) => /can't use \$USER\.\* or \$PERIOD\.\*/.test(issue))).toBe(true);
  });

  it("refuses a secret header naming no secret - not left to the first run", async () => {
    const key = `readiness-${randomUUID().slice(0, 8)}`;
    await context.secrets.set(key, "s3cret", "WORKFLOWS");
    try {
      const start = op("start", "totalbase.start", { trigger: "MANUAL" });
      const call = op("call", "totalbase.http-request", { method: "GET", url: "https://example.com", secretHeaders: [{ name: "Authorization", secret: key }, { name: "X-Key", secret: "ACCOUNTING_API_KEY" }] });
      expect(await issuesOf({ operations: [start, call], connections: [link(start, call)] })).toEqual(['Step "call": no workflow secret "ACCOUNTING_API_KEY" in Settings > Secrets.']);
    } finally {
      await context.secrets.delete(key);
    }
  });

  it("refuses a table that no longer exists - never rewritten by name", async () => {
    const start = op("start", "totalbase.start", { trigger: "MANUAL" });
    const read = op("read", "totalbase.read-records", { resource: randomUUID(), query: {} });
    expect(await issuesOf({ operations: [start, read], connections: [link(start, read)] })).toEqual(['Step "read": the table it names no longer exists.']);
  });
});
