import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const SLUG = "admin-workflows-test";
const VIEW = "admin_workflows_test_view";

/** Start (MANUAL) -> Finish with `result`. */
function definitionReturning(result: unknown): Record<string, unknown> {
  const startId = randomUUID();
  const finishId = randomUUID();
  return {
    operations: [
      { id: startId, type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration: { trigger: "MANUAL" } },
      { id: finishId, type: "totalbase.finish-result", configuration_version: 1, label: "Done", key: "finish", configuration: { result } },
    ],
    connections: [{ source: startId, target: finishId, output: "next" }],
  };
}

/**
 * /admin/api/workflows over HTTP - the editor's side: create, draft
 * (optimistic revision), test-run of the draft, publish, enable, a
 * production run of the published version, runs, INVOKE roles,
 * versions, restore, duplicate, delete. The engine and the service have
 * their own tests; this pins the routes' wiring and status codes.
 */
describe("Admin workflows (/admin/api/workflows)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let id: string;

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url: `/admin/api/workflows${url}`,
      headers: { authorization: `Bearer ${adminToken}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  const revision = async () => (await call("GET", `/${id}`)).json().data.revision as string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DELETE FROM totalbase.workflows WHERE slug LIKE '${SLUG}%'`);
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.workflows WHERE slug LIKE '${SLUG}%'`);
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name = '${VIEW}'`);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DELETE FROM totalbase.roles WHERE name = 'admin-workflows-test-role'`);
    await app.close();
  });

  it("creates a workflow as an unpublished draft", async () => {
    const created = await call("POST", "", { data: { name: "Admin workflows test", slug: SLUG, historyLevel: "DETAILED" } });
    expect(created.statusCode, created.body).toBe(201);
    id = created.json().data.id;
    expect(created.json().data).toMatchObject({ publishedVersion: null, historyLevel: "DETAILED" });
    expect((await call("GET", `/${id}/draft`)).statusCode).toBe(200);
  });

  it("saves the draft under an optimistic revision and refuses a stale one", async () => {
    const stale = await revision();
    const saved = await call("PUT", `/${id}/draft`, { data: { revision: stale, definition: definitionReturning({ from: "v1" }) } });
    expect(saved.statusCode, saved.body).toBe(200);
    const conflict = await call("PUT", `/${id}/draft`, { data: { revision: stale, definition: definitionReturning({ from: "stale" }) } });
    expect(conflict.json().errors[0].code).toBe("WORKFLOW_REVISION_CONFLICT");
  });

  it("test-runs the draft", async () => {
    const res = await call("POST", `/${id}/test-run`, { data: {} });
    expect(res.statusCode, res.body).toBe(200);
    // `error` is there, null - the same shape a run read back later has.
    expect(res.json().data.run).toMatchObject({ mode: "TEST", status: "SUCCEEDED", result: { data: { from: "v1" } }, error: null });
  });

  // Read records reads a VIEW as well as a TABLE (Specification_Workflows.md §5.2), a PDF
  // step's data comes from earlier steps through {{...}} templates, and
  // Create file stores that binary PDF (base64) intact, in the chosen folder.
  it("test-runs a draft that reads a view, fills a PDF from its rows and stores it as a file", async () => {
    const folder = await context.foldersAdmin.create({ name: `${SLUG}-folder` });
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT 'Hello from a view'::text AS greeting`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'VIEW', 'ACTIVE', ARRAY['GET'])
       RETURNING id`,
      [`public.${VIEW}`, VIEW],
    );
    const [startId, readId, pdfId, fileId, finishId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const definition = {
      operations: [
        { id: startId, type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration: { trigger: "MANUAL" } },
        { id: readId, type: "totalbase.read-records", configuration_version: 1, label: "Read", key: "read", configuration: { resource: rows[0]!.id, query: { fields: "greeting" } } },
        {
          id: pdfId, type: "totalbase.generate-pdf", configuration_version: 1, label: "PDF", key: "pdf",
          configuration: {
            design: { basePdf: { width: 80, height: "{{start.data.height}}", padding: [0, 0, 0, 0] }, schemas: [[{ name: "greeting", type: "text", position: { x: 4, y: 4 }, width: 72, height: 8 }]] },
            data: { greeting: "{{read.data[0].greeting}}" },
          },
        },
        {
          id: fileId, type: "totalbase.create-file", configuration_version: 1, label: "File", key: "file",
          configuration: { name: "greeting.pdf", contentType: "application/pdf", encoding: "base64", content: "{{pdf.data.content}}", folder: folder.id },
        },
        { id: finishId, type: "totalbase.finish-result", configuration_version: 1, label: "Done", key: "finish", configuration: { result: { pdf: "{{pdf.data}}", file: "{{file.data}}" } } },
      ],
      connections: [
        { source: startId, target: readId, output: "next" },
        { source: readId, target: pdfId, output: "next" },
        { source: pdfId, target: fileId, output: "next" },
        { source: fileId, target: finishId, output: "next" },
      ],
    };
    const saved = await call("PUT", `/${id}/draft`, { data: { revision: await revision(), definition } });
    expect(saved.statusCode, saved.body).toBe(200);

    const res = await call("POST", `/${id}/test-run`, { data: { height: 40 } });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json().data;
    expect(run.run.status, JSON.stringify(run.run.error)).toBe("SUCCEEDED");
    const pdfStep = run.steps.find((step: { operationType: string }) => step.operationType === "totalbase.generate-pdf");
    expect(pdfStep.input).toMatchObject({ design: { basePdf: { height: 40 } }, data: { greeting: "Hello from a view" } });
    const { pdf, file } = run.run.result.data;
    expect(pdf).toMatchObject({ mimeType: "application/pdf" });
    const stored = await context.filesAdmin.readContent(file.asset);
    expect(stored.file).toMatchObject({ folder: folder.id, mime_type: "application/pdf" });
    expect(stored.content.equals(Buffer.from(pdf.content, "base64"))).toBe(true);
    expect(stored.content.subarray(0, 5).toString()).toBe("%PDF-");
    await context.filesAdmin.remove(file.asset);
    await context.foldersAdmin.remove(folder.id);

    await call("PUT", `/${id}/draft`, { data: { revision: await revision(), definition: definitionReturning({ from: "v1" }) } });
  });

  it("refuses a production run before publishing, then publishes, enables and runs it", async () => {
    expect((await call("POST", `/${id}/run`, { data: {} })).statusCode).toBeGreaterThanOrEqual(400);

    const published = await call("POST", `/${id}/publish`, { data: { revision: await revision() } });
    expect(published.statusCode, published.body).toBe(200);
    const enabled = await call("PATCH", `/${id}`, { data: { revision: await revision(), enabled: true } });
    expect(enabled.json().data.enabled).toBe(true);

    const run = await call("POST", `/${id}/run`, { data: {} });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().data.run).toMatchObject({ mode: "PRODUCTION", status: "SUCCEEDED" });

    const runs = await call("GET", `/${id}/runs`);
    expect(runs.statusCode, runs.body).toBe(200);
    const runId = run.json().data.run.id as string;
    // A paginated list: rows in `data`, the total in `meta`.
    expect(runs.json().data.map((r: { id: string }) => r.id)).toContain(runId);
    expect(runs.json().meta.total).toBeGreaterThanOrEqual(1);
    expect((await call("GET", `/runs/${runId}`)).statusCode).toBe(200);

    // Narrowed by status, trigger, mode and when it started; an unknown value is refused (§16.3).
    const ids = async (query: string) => (await call("GET", `/${id}/runs?${query}`)).json().data.map((r: { id: string }) => r.id) as string[];
    expect(await ids("status=SUCCEEDED&trigger=MANUAL&mode=PRODUCTION")).toContain(runId);
    expect(await ids("status=FAILED")).not.toContain(runId);
    expect(await ids("mode=TEST")).not.toContain(runId);
    expect(await ids(`from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).toContain(runId);
    expect(await ids(`to=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).not.toContain(runId);
    const bad = await call("GET", `/${id}/runs?status=DONE`);
    expect([bad.statusCode, bad.json().errors[0].code]).toEqual([400, "INVALID_QUERY"]);
    expect((await call("GET", `/${id}/runs?pageSize=1`)).json().data).toHaveLength(1);
  });

  it("refuses a production run of a disabled workflow with 409 WORKFLOW_DISABLED, not 404", async () => {
    expect((await call("PATCH", `/${id}`, { data: { revision: await revision(), enabled: false } })).statusCode).toBe(200);
    const res = await call("POST", `/${id}/run`, { data: {} });
    expect([res.statusCode, res.json().errors[0].code]).toEqual([409, "WORKFLOW_DISABLED"]);
    expect((await call("PATCH", `/${id}`, { data: { revision: await revision(), enabled: true } })).statusCode).toBe(200);
  });

  it("refuses an on-demand run of a webhook workflow with 409 WORKFLOW_NOT_RUNNABLE", async () => {
    let webhook = await context.workflowsAdmin.create({ name: `Run webhook ${randomUUID().slice(0, 8)}`, startConfiguration: { trigger: "WEBHOOK", method: "POST", access: "AUTHENTICATED" } });
    try {
      webhook = await context.workflowsAdmin.publish(webhook.id, webhook.revision, () => {});
      await context.workflowsAdmin.update(webhook.id, { revision: webhook.revision, enabled: true });
      const res = await call("POST", `/${webhook.id}/run`, { data: {} });
      expect([res.statusCode, res.json().errors[0].code]).toEqual([409, "WORKFLOW_NOT_RUNNABLE"]);
    } finally {
      await context.workflowsAdmin.remove(webhook.id);
    }
  });

  it("answers 404 for a child route of an unknown workflow", async () => {
    const unknown = randomUUID();
    for (const [method, url, payload] of [
      ["GET", `/${unknown}/runs`],
      ["GET", `/${unknown}/roles`],
      ["PUT", `/${unknown}/roles`, { data: { roleIds: [] } }],
      ["GET", `/${unknown}/called-by`],
      ["GET", `/${unknown}/versions`],
      ["GET", `/${unknown}/versions/1`],
    ] as const) {
      const res = await call(method, url, payload);
      expect([res.statusCode, res.json().errors[0].code], `${method} ${url}`).toEqual([404, "WORKFLOW_NOT_FOUND"]);
    }
  });

  it("validates the :version path parameter: 400 when not a positive integer, 404 when missing", async () => {
    for (const bad of ["abc", "0", "1.5", "-1"]) {
      expect((await call("GET", `/${id}/versions/${bad}`)).statusCode, bad).toBe(400);
    }
    expect((await call("POST", `/${id}/versions/abc/restore`, { data: { revision: await revision() } })).statusCode).toBe(400);
    expect((await call("POST", `/${id}/versions/abc/duplicate`, { data: { name: "Never created" } })).statusCode).toBe(400);
    expect((await call("GET", `/${id}/versions/999`)).statusCode).toBe(404);
  });

  it("edits name, description, slug and the history switch under the revision", async () => {
    const other = await call("POST", "", { data: { name: "Admin workflows test other", slug: `${SLUG}-other` } });
    expect(other.statusCode, other.body).toBe(201);
    const stale = await revision();
    const edited = await call("PATCH", `/${id}`, { data: { revision: stale, name: "Admin workflows renamed", description: "A note", slug: `${SLUG}-renamed`, historyEnabled: false } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().data).toMatchObject({ id, name: "Admin workflows renamed", description: "A note", slug: `${SLUG}-renamed`, historyEnabled: false });
    expect((await call("PATCH", `/${id}`, { data: { revision: stale, name: "Never" } })).json().errors[0].code).toBe("WORKFLOW_REVISION_CONFLICT");
    const taken = await call("PATCH", `/${id}`, { data: { revision: await revision(), slug: `${SLUG}-other` } });
    expect([taken.statusCode, taken.json().errors[0].code]).toEqual([409, "WORKFLOW_SLUG_CONFLICT"]);
    // The history switch is snapshotted on the next run.
    const run = await call("POST", `/${id}/test-run`, { data: {} });
    expect(run.json().data.run.historyEnabled).toBe(false);
    const restored = await call("PATCH", `/${id}`, { data: { revision: await revision(), name: "Admin workflows test", description: null, slug: SLUG, historyEnabled: true } });
    expect(restored.json().data).toMatchObject({ name: "Admin workflows test", description: null, slug: SLUG, historyEnabled: true });
  });

  it("previews a schedule with month and weekday names, and a workflow's last occurrence", async () => {
    const preview = (query: string) => call("GET", `/cron/preview?${query}`);
    const named = await preview(`expression=${encodeURIComponent("0 9 * JAN-DEC MON-FRI")}&timezone=UTC&count=2`);
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().data.occurrences).toHaveLength(2);
    for (const occurrence of named.json().data.occurrences as string[]) expect([1, 2, 3, 4, 5]).toContain(new Date(occurrence).getUTCDay());
    expect(named.json().data.lastOccurrence).toBeNull();

    const expression = encodeURIComponent("0 9 * * MON-FRI");
    expect((await preview(`expression=${expression}&timezone=UTC&workflow=${id}`)).json().data.lastOccurrence).toBeNull();
    // The newest of the occurrence claims and the scheduled runs.
    await database.query(`INSERT INTO totalbase.workflows_crons (workflow, scheduled_at) VALUES ($1, '2026-10-01T09:00:00Z'), ($1, '2026-10-02T09:00:00Z')`, [id]);
    expect((await preview(`expression=${expression}&timezone=UTC&workflow=${id}`)).json().data.lastOccurrence).toBe("2026-10-02T09:00:00.000Z");
    await database.query(`DELETE FROM totalbase.workflows_crons WHERE workflow = $1`, [id]);
    const scheduled = await context.workflowRuns.createRun({
      workflow: id, version: null, trigger: "CRON", mode: "PRODUCTION", initiator: { type: "CRON", scheduledAt: "2026-09-30T09:00:00.000Z" },
      executor: { type: "SYSTEM" }, historyEnabled: true, historyLevel: "SUMMARY", expiresAt: new Date(Date.now() + 60_000),
    });
    await context.workflowRuns.finishRun(scheduled.id, { status: "SUCCEEDED" });
    expect((await preview(`expression=${expression}&timezone=UTC&workflow=${id}`)).json().data.lastOccurrence).toBe("2026-09-30T09:00:00.000Z");
    expect((await preview(`expression=${expression}&timezone=UTC&workflow=nope`)).json().errors[0].code).toBe("INVALID_QUERY");
  });

  it("replaces the roles that may invoke the workflow - the complete set, no DENY", async () => {
    const role = await context.roles.create("admin-workflows-test-role", { apiAccess: true });
    const other = await context.roles.create("admin-workflows-test-other", { apiAccess: true });
    try {
      const put = await call("PUT", `/${id}/roles`, { data: { roleIds: [role.id, role.id] } });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json().data).toEqual([role.id]);
      expect((await call("GET", `/${id}/roles`)).json().data).toEqual([role.id]);
      expect(await context.workflowPermissions.resolveInvoke([role.id], id)).toBe("ALLOW");
      expect(await context.workflowPermissions.resolveInvoke([other.id], id)).toBe("UNDEFINED");
      // A user holding a granted role and one without is allowed - object access knows no DENY.
      expect(await context.workflowPermissions.resolveInvoke([role.id, other.id], id)).toBe("ALLOW");

      // The set is replaced: a role left out loses its grant.
      const swapped = await call("PUT", `/${id}/roles`, { data: { roleIds: [other.id] } });
      expect(swapped.json().data).toEqual([other.id]);
      expect(await context.workflowPermissions.resolveInvoke([role.id], id)).toBe("UNDEFINED");
      expect(await context.workflowPermissions.resolveInvoke([other.id], id)).toBe("ALLOW");

      // A malformed body is refused - the set is unchanged.
      const malformed = await call("PUT", `/${id}/roles`, { data: { allow: [role.id] } });
      expect([malformed.statusCode, malformed.json().errors[0].code]).toEqual([400, "INVALID_QUERY"]);
      // Atomic: one bad role id (no such role) fails the whole replace.
      const failed = await call("PUT", `/${id}/roles`, { data: { roleIds: [role.id, randomUUID()] } });
      expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
      expect(failed.statusCode, failed.body).toBeLessThan(500);
      expect((await call("GET", `/${id}/roles`)).json().data).toEqual([other.id]);

      // Empty: administrators only.
      await call("PUT", `/${id}/roles`, { data: { roleIds: [] } });
      expect((await call("GET", `/${id}/roles`)).json().data).toEqual([]);
      expect(await context.workflowPermissions.resolveInvoke([role.id, other.id], id)).toBe("UNDEFINED");
    } finally {
      await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [[role.id, other.id]]);
    }
  });

  it("keeps versions, restores one and duplicates one", async () => {
    await call("PUT", `/${id}/draft`, { data: { revision: await revision(), definition: definitionReturning({ from: "v2" }) } });
    await call("POST", `/${id}/publish`, { data: { revision: await revision() } });
    const versions = (await call("GET", `/${id}/versions`)).json().data;
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect((await call("GET", `/${id}/versions/1`)).statusCode).toBe(200);

    // Restore replaces the draft only: the live version (v2) still runs until Publish.
    const restored = await call("POST", `/${id}/versions/1/restore`, { data: { revision: await revision() } });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await call("POST", `/${id}/run`, { data: {} })).json().data.run.result).toEqual({ data: { from: "v2" } });
    expect((await call("POST", `/${id}/publish`, { data: { revision: await revision() } })).statusCode).toBe(200);
    const run = await call("POST", `/${id}/run`, { data: {} });
    expect(run.json().data.run.result).toEqual({ data: { from: "v1" } });

    const copy = await call("POST", `/${id}/versions/1/duplicate`, { data: { name: "Admin workflows test copy", slug: `${SLUG}-copy` } });
    expect(copy.statusCode, copy.body).toBe(201);
  });

  it("previews a cron schedule and lists the operation types", async () => {
    const preview = await call("GET", `/cron/preview?expression=${encodeURIComponent("0 9 * * 1")}&timezone=UTC&count=3`);
    expect(preview.json().data.occurrences).toHaveLength(3);
    expect((await call("GET", "/operation-types")).json().data).toContain("totalbase.finish-result");
  });

  it("deletes a workflow", async () => {
    expect((await call("DELETE", `/${id}`)).statusCode).toBe(204);
    expect((await call("GET", `/${id}`)).statusCode).toBe(404);
  });
});
