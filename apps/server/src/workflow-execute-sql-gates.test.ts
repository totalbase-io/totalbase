import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * Security regression (Workflows.md §5.7, Administration.md §5.1): an Execute SQL step ran raw SQL past both SQL
 * Console switches - with `sql_console.enabled` off, and written by an API token (an agent) while
 * `sql_console.token_access` was off, which keeps tokens from raw SQL in the console itself.
 */
describe("Execute SQL steps follow the SQL Console's switches", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let session: string;
  let token: string;
  let ownerId: string;
  const suffix = uniqueSuffix();
  const workflowIds: string[] = [];

  const call = (method: "GET" | "PUT" | "POST", url: string, credential: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${credential}` }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const definition = (statement: string) => {
    const start = randomUUID();
    const step = randomUUID();
    return {
      operations: [
        { id: start, type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration: { trigger: "MANUAL" } },
        { id: step, type: "totalbase.execute-sql", configuration_version: 1, label: "SQL", key: "sql", configuration: { statement, executeAs: ownerId } },
      ],
      connections: [{ source: start, target: step, output: "next" }],
    };
  };
  async function workflow(name: string): Promise<{ id: string; revision: string }> {
    const created = await context.workflowsAdmin.create({ name, slug: name });
    workflowIds.push(created.id);
    return { id: created.id, revision: (await context.workflowsAdmin.get(created.id)).revision };
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    session = await adminToken(context);
    const owner = await context.auth.users.create({ email: `wfsql-${suffix}@example.com`, name: "Agent" });
    ownerId = owner.id;
    await context.roleAssignments.assignRoleToUser(owner.id, await context.roles.getAdministratorsRoleId());
    token = (await context.usersApis.create({ userId: owner.id, name: `wfsql-${suffix}`, plane: "ADMIN" })).plainKey;
  });

  afterAll(async () => {
    for (const id of workflowIds) await context.workflowsAdmin.remove(id).catch(() => undefined);
    await context.settings.reset("sql_console.enabled");
    await context.settings.reset("sql_console.token_access");
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [ownerId]);
    await app.close();
  });

  it("refuses an API token writing one while tokens may not run SQL; a session, or a token once allowed, writes it", async () => {
    const draft = await workflow(`wfsql-token-${suffix}`);
    const byToken = await call("PUT", `/admin/api/workflows/${draft.id}/draft`, token, { data: { revision: draft.revision, definition: definition("SELECT 1") } });
    expect([byToken.statusCode, byToken.json().errors?.[0]?.code], byToken.body).toEqual([403, "SQL_CONSOLE_DISABLED"]);

    const bySession = await call("PUT", `/admin/api/workflows/${draft.id}/draft`, session, { data: { revision: draft.revision, definition: definition("SELECT 1") } });
    expect(bySession.statusCode, bySession.body).toBe(200);

    await context.settings.set("sql_console.token_access", true);
    const revision = (await context.workflowsAdmin.get(draft.id)).revision;
    const allowed = await call("PUT", `/admin/api/workflows/${draft.id}/draft`, token, { data: { revision, definition: definition("SELECT 2") } });
    expect(allowed.statusCode, allowed.body).toBe(200);
    await context.settings.reset("sql_console.token_access");
  });

  it("refuses to run the step while the SQL Console is off", async () => {
    const draft = await workflow(`wfsql-off-${suffix}`);
    await context.workflowsAdmin.saveDraft(draft.id, draft.revision, definition("SELECT 1 AS one"));
    await context.settings.set("sql_console.enabled", false);
    const run = await call("POST", `/admin/api/workflows/${draft.id}/test-run`, session, { data: {} });
    expect(run.body).toContain("SQL_CONSOLE_DISABLED");
    await context.settings.reset("sql_console.enabled");
  });
});
