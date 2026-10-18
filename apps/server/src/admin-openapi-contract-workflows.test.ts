import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAdminContract, type AdminContract, type Schema } from "./admin-openapi-contract-support.js";

const SLUG = `contract-wf-${randomUUID().slice(0, 8)}`;
const SQL_MARKER = `contract_sql_${randomUUID().replace(/-/g, "")}`;

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
 * The workflows, SQL Console and OpenAPI areas of the Admin API document
 * against real responses (admin-openapi-contract-support.ts): every
 * documented JSON body carries exactly the documented keys.
 */
describe("Admin OpenAPI matches real responses - workflows, SQL Console, OpenAPI", () => {
  let contract: AdminContract;
  const workflowIds: string[] = [];
  const historyIds: string[] = [];
  let id: string;
  let runId: string;

  const call = (method: string, url: string, payload?: unknown) =>
    contract.app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${contract.adminToken}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  const revision = async () => (await call("GET", `/admin/api/workflows/${id}`)).json().data.revision as string;
  const keysOf = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

  beforeAll(async () => {
    contract = await setupAdminContract();
  });

  afterAll(async () => {
    for (const workflowId of workflowIds) await contract.database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [workflowId]);
    for (const historyId of historyIds) await contract.database.query(`DELETE FROM totalbase.sql_queries WHERE id = $1`, [historyId]);
    await contract.close();
  });

  it("documents every route of the three areas, with resolvable component refs", () => {
    const ours = Object.entries(contract.spec.paths).filter(([path]) =>
      path.startsWith("/admin/api/workflows") || path.startsWith("/admin/api/sql") || path.startsWith("/admin/api/openapi"));
    expect(ours.length).toBeGreaterThan(0);
    for (const [path, item] of ours) {
      for (const [method, operation] of Object.entries(item)) {
        expect((operation as unknown as { tags: string[] }).tags, `${method.toUpperCase()} ${path} is undocumented`).not.toEqual(["admin"]);
      }
    }
    const refs = JSON.stringify(ours).match(/#\/components\/schemas\/[A-Za-z0-9]+/g) ?? [];
    for (const name of new Set(refs.map((r) => r.split("/").pop()!))) {
      expect(contract.spec.components.schemas[name], name).toBeDefined();
    }
  });

  it("workflow writes", async () => {
    const created = await call("POST", "/admin/api/workflows", { data: { name: SLUG, slug: SLUG } });
    expect(created.statusCode, created.body).toBe(201);
    id = created.json().data.id;
    workflowIds.push(id);
    contract.expectKeys(created.json().data, contract.dataSchema("/admin/api/workflows", "post", "201"), "POST /workflows");

    const saved = await call("PUT", `/admin/api/workflows/${id}/draft`, { data: { revision: await revision(), definition: definitionReturning({ ok: true }) } });
    expect(saved.statusCode, saved.body).toBe(200);
    contract.expectKeys(saved.json().data, contract.dataSchema("/admin/api/workflows/{id}/draft", "put"), "PUT /draft");
    contract.expectKeys(saved.json().data.workflow, keysOf("Workflow"), "PUT /draft workflow");

    const testRun = await call("POST", `/admin/api/workflows/${id}/test-run`, { data: {} });
    expect(testRun.statusCode, testRun.body).toBe(200);
    contract.expectKeys(testRun.json().data, contract.dataSchema("/admin/api/workflows/{id}/test-run", "post"), "POST /test-run");
    contract.expectKeys(testRun.json().data.run, keysOf("WorkflowRun"), "test-run run");
    contract.expectKeys(testRun.json().data.steps[0], keysOf("WorkflowRunStep"), "test-run step");

    const published = await call("POST", `/admin/api/workflows/${id}/publish`, { data: { revision: await revision() } });
    expect(published.statusCode, published.body).toBe(200);
    contract.expectKeys(published.json().data, contract.dataSchema("/admin/api/workflows/{id}/publish", "post"), "POST /publish");

    const enabled = await call("PATCH", `/admin/api/workflows/${id}`, { data: { revision: await revision(), enabled: true } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    contract.expectKeys(enabled.json().data, contract.dataSchema("/admin/api/workflows/{id}", "patch"), "PATCH /workflows/{id}");

    const run = await call("POST", `/admin/api/workflows/${id}/run`, { data: {} });
    expect(run.statusCode, run.body).toBe(200);
    contract.expectKeys(run.json().data.run, keysOf("WorkflowRun"), "run run");
    runId = run.json().data.run.id;

    // A role granted, so the GET has a row to compare with its schema below.
    const roleId = (await contract.context.roles.list())[0]!.id;
    const roles = await call("PUT", `/admin/api/workflows/${id}/roles`, { data: { roleIds: [roleId] } });
    expect([roles.statusCode, roles.json().data]).toEqual([200, [roleId]]);
    expect(contract.dataSchema("/admin/api/workflows/{id}/roles", "put")).toMatchObject({ type: "array" });

    const restored = await call("POST", `/admin/api/workflows/${id}/versions/1/restore`, { data: { revision: await revision() } });
    expect(restored.statusCode, restored.body).toBe(200);
    contract.expectKeys(restored.json().data, contract.dataSchema("/admin/api/workflows/{id}/versions/{version}/restore", "post"), "POST /restore");

    const copy = await call("POST", `/admin/api/workflows/${id}/versions/1/duplicate`, { data: { name: `${SLUG}-copy`, slug: `${SLUG}-copy` } });
    expect(copy.statusCode, copy.body).toBe(201);
    workflowIds.push(copy.json().data.id);
    contract.expectKeys(copy.json().data, contract.dataSchema("/admin/api/workflows/{id}/versions/{version}/duplicate", "post", "201"), "POST /duplicate");

    // A caller: its draft has an Execute workflow step targeting `id`.
    const caller = await call("POST", "/admin/api/workflows", { data: { name: `${SLUG}-caller`, slug: `${SLUG}-caller` } });
    const callerId = caller.json().data.id as string;
    workflowIds.push(callerId);
    const definition = definitionReturning(null) as { operations: Record<string, unknown>[]; connections: unknown[] };
    definition.operations.push({ id: randomUUID(), type: "totalbase.execute-workflow", configuration_version: 1, label: "Call", key: "call", configuration: { workflow: id } });
    const callerSaved = await call("PUT", `/admin/api/workflows/${callerId}/draft`, { data: { revision: caller.json().data.revision, definition } });
    expect(callerSaved.statusCode, callerSaved.body).toBe(200);
  });

  it("workflow reads", async () => {
    await contract.expectMatches("/admin/api/workflows", "/admin/api/workflows");
    await contract.expectMatches(`/admin/api/workflows/${id}`, "/admin/api/workflows/{id}");
    await contract.expectMatches(`/admin/api/workflows/${id}/draft`, "/admin/api/workflows/{id}/draft");
    await contract.expectMatches(`/admin/api/workflows/${id}/versions`, "/admin/api/workflows/{id}/versions");
    await contract.expectMatches(`/admin/api/workflows/${id}/versions/1`, "/admin/api/workflows/{id}/versions/{version}");
    await contract.expectMatches(`/admin/api/workflows/${id}/called-by`, "/admin/api/workflows/{id}/called-by");
    await contract.expectMatches(`/admin/api/workflows/${id}/runs`, "/admin/api/workflows/{id}/runs");
    await contract.expectMatches(`/admin/api/workflows/runs/${runId}`, "/admin/api/workflows/runs/{runId}");
    await contract.expectMatches(`/admin/api/workflows/cron/preview?expression=${encodeURIComponent("0 9 * * 1")}&timezone=UTC&count=2`, "/admin/api/workflows/cron/preview");

    const draft = (await contract.get(`/admin/api/workflows/${id}/draft`)).json().data;
    contract.expectKeys(draft.workflow, keysOf("Workflow"), "draft workflow");
    expect(Object.keys(draft.definition).sort()).toEqual(["connections", "operations"]);
    const runs = (await contract.get(`/admin/api/workflows/${id}/runs`)).json();
    contract.expectKeys(runs.meta, contract.spec.paths["/admin/api/workflows/{id}/runs"]!["get"]!.responses["200"]!.content!["application/json"]!.schema.properties!["meta"]!, "runs meta");
    expect(runs.meta.total).toBeGreaterThanOrEqual(1);
    const detail = (await contract.get(`/admin/api/workflows/runs/${runId}`)).json().data;
    contract.expectKeys(detail.run, keysOf("WorkflowRun"), "run detail run");
    contract.expectKeys(detail.steps[0], keysOf("WorkflowRunStep"), "run detail step");

    // Cancel answers 202 with the run while it is running; a finished run is 409.
    expect(contract.spec.paths["/admin/api/workflows/runs/{runId}/cancel"]!["post"]!.responses["202"]!.content!["application/json"]!.schema)
      .toMatchObject({ properties: { data: { $ref: "#/components/schemas/WorkflowRun" } } });
    const cancel = await call("POST", `/admin/api/workflows/runs/${runId}/cancel`);
    expect([cancel.statusCode, cancel.json().errors[0].code]).toEqual([409, "WORKFLOW_RUN_NOT_CANCELLABLE"]);

    // An unknown run is its own 404 code, on both run routes.
    const unknownRun = "00000000-0000-4000-8000-000000000000";
    const missing = await call("GET", `/admin/api/workflows/runs/${unknownRun}`);
    expect([missing.statusCode, missing.json().errors[0].code]).toEqual([404, "WORKFLOW_RUN_NOT_FOUND"]);
    const missingCancel = await call("POST", `/admin/api/workflows/runs/${unknownRun}/cancel`);
    expect([missingCancel.statusCode, missingCancel.json().errors[0].code]).toEqual([404, "WORKFLOW_RUN_NOT_FOUND"]);

    // Arrays of plain values: checked by type rather than by keys.
    const types = await contract.get("/admin/api/workflows/operation-types");
    expect(types.json().data).toContain("totalbase.finish-result");
    expect(contract.dataSchema("/admin/api/workflows/operation-types")).toMatchObject({ type: "array", items: { type: "string" } });
    // GET .../roles answers a list of ids, not rows - its schema is checked by shape, above.
    expect((await contract.get(`/admin/api/workflows/${id}/roles`)).json().data).toEqual([(await contract.context.roles.list())[0]!.id]);
    expect(contract.dataSchema("/admin/api/workflows/{id}/roles")).toMatchObject({ type: "array", items: { type: "string" } });
    await contract.expectMatches(`/admin/api/workflows/cron/preview?expression=${encodeURIComponent("0 9 * * MON-FRI")}&timezone=UTC&workflow=${id}`, "/admin/api/workflows/cron/preview");
  });

  it("SQL Console", async () => {
    const enabled = await contract.context.settings.get("sql_console.enabled");
    expect(enabled, "sql_console.enabled is off on the test database").toBe(true);

    const executed = await call("POST", "/admin/api/sql/execute", { data: { sql: `SELECT 1 AS ${SQL_MARKER}` } });
    expect(executed.statusCode, executed.body).toBe(200);
    contract.expectKeys(executed.json().data, contract.dataSchema("/admin/api/sql/execute", "post"), "POST /sql/execute");
    contract.expectKeys(executed.json().data.columns[0], { properties: { name: {}, dataType: {} } }, "columns[0]");
    const { rows } = await contract.database.query<{ id: string }>(
      `SELECT id FROM totalbase.sql_queries WHERE sql_text = $1`,
      [`SELECT 1 AS ${SQL_MARKER}`],
    );
    expect(rows).toHaveLength(1);
    historyIds.push(rows[0]!.id);

    const explained = await call("POST", "/admin/api/sql/explain", { data: { sql: "SELECT 1" } });
    expect(explained.statusCode, explained.body).toBe(200);
    contract.expectKeys(explained.json().data, contract.dataSchema("/admin/api/sql/explain", "post"), "POST /sql/explain");
    expect(Array.isArray(explained.json().data.plan)).toBe(true);

    await contract.expectMatches(`/admin/api/sql/history?search=${SQL_MARKER}`, "/admin/api/sql/history");
    expect((await contract.get(`/admin/api/sql/history?search=${SQL_MARKER}`)).json().meta).toEqual({ total: 1 });
    await contract.expectMatches(`/admin/api/sql/history/${rows[0]!.id}`, "/admin/api/sql/history/{id}");

    // A cutoff long before any row: nothing is purged.
    const purged = await call("DELETE", "/admin/api/sql/history?before=2000-01-01T00:00:00Z");
    expect(purged.statusCode, purged.body).toBe(200);
    expect(purged.json().data).toEqual({ deletedCount: 0 });
    contract.expectKeys(purged.json().data, contract.dataSchema("/admin/api/sql/history", "delete"), "DELETE /sql/history");
  });

  it("OpenAPI documents answer bare OpenAPI 3.1, not the data envelope", async () => {
    const roleId = (await contract.context.roles.list())[0]!.id;
    for (const url of ["/admin/api/openapi", `/admin/api/openapi/data?role=${roleId}`, `/admin/api/openapi/data?role=${roleId}&as=api_key`]) {
      const res = await contract.get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.json().openapi, url).toMatch(/^3\.1\./);
      expect(res.json().data, url).toBeUndefined();
    }
    for (const path of ["/admin/api/openapi", "/admin/api/openapi/data"]) {
      const schema = contract.spec.paths[path]!["get"]!.responses["200"]!.content!["application/json"]!.schema;
      expect(schema.properties?.["data"], path).toBeUndefined();
      expect(schema.type, path).toBe("object");
    }
    expect((await contract.get("/admin/api/openapi/data")).statusCode).toBe(400);
    expect((await contract.get(`/admin/api/openapi/data?role=${randomUUID()}`)).statusCode).toBe(404);
  });
});
