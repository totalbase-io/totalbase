import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/** Publish readiness (Specification_Workflows.md §10.2): every issue at once, each in the editor's words. */
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

  it("refuses a secret header naming no secret - not left to the first run (Beta_Findings 3.6)", async () => {
    const key = `readiness-${randomUUID().slice(0, 8)}`;
    await context.secrets.set(key, "s3cret");
    try {
      const start = op("start", "totalbase.start", { trigger: "MANUAL" });
      const call = op("call", "totalbase.http-request", { method: "GET", url: "https://example.com", secretHeaders: [{ name: "Authorization", secret: key }, { name: "X-Key", secret: "ACCOUNTING_API_KEY" }] });
      expect(await issuesOf({ operations: [start, call], connections: [link(start, call)] })).toEqual(['Step "call": no secret "ACCOUNTING_API_KEY" in Settings > Secrets.']);
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
