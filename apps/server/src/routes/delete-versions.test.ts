import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const PREFIX = "delete-versions";

/**
 * Delete old versions (Specification.md §13.4): every version before N goes,
 * never the live one; a workflow version with runs is kept; audited.
 */
describe("DELETE /admin/api/<pillar>/:id/versions?before=N", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let adminToken: string;
  let dashboardId: string;
  let workflowId: string;

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;

    // A dashboard with five versions - each Publish after a change to its variables.
    dashboardId = (await context.dashboardsAdmin.create({ name: `${PREFIX} dash`, slug: `${PREFIX}-dash` })).id;
    for (let i = 1; i <= 5; i++) {
      await context.dashboardsAdmin.update(dashboardId, { variables: [{ name: "n", label: `N${i}`, type: "NUMBER" }] });
      await context.dashboardsAdmin.publish(dashboardId, null);
    }

    // A workflow with four versions, written directly: only their numbers and runs matter here.
    workflowId = (await context.workflowsAdmin.create({ name: `${PREFIX} flow`, slug: `${PREFIX}-flow` })).id;
    for (let version = 1; version <= 4; version++) {
      await context.database.query(
        `INSERT INTO totalbase.workflows_versions (workflow, version, definition_snapshot) VALUES ($1, $2, '{}'::jsonb)`,
        [workflowId, version],
      );
    }
  });

  afterAll(async () => {
    await context.database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
    await context.database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [workflowId]);
    await app.close();
  });

  const remove = (pillar: string, id: string, before: string) =>
    app.inject({ method: "DELETE", url: `/admin/api/${pillar}/${id}/versions?before=${before}`, headers: { authorization: `Bearer ${adminToken}` } });

  it("deletes the versions before N, keeps the rest, and the next Publish stays latest + 1", async () => {
    const res = await remove("dashboards", dashboardId, "4");
    expect([res.statusCode, res.json().data]).toEqual([200, { deleted: [1, 2, 3] }]);
    expect((await context.dashboardsAdmin.listVersions(dashboardId)).map((v) => v.version)).toEqual([5, 4]);

    await context.dashboardsAdmin.update(dashboardId, { variables: [{ name: "n", label: "N6", type: "NUMBER" }] });
    expect((await context.dashboardsAdmin.publish(dashboardId, null)).version).toBe(6);
  });

  it("never deletes the live version, whatever N says", async () => {
    const res = await remove("dashboards", dashboardId, "99");
    expect(res.json().data.deleted).toEqual([4, 5]);
    expect((await context.dashboardsAdmin.listVersions(dashboardId)).map((v) => v.version)).toEqual([6]);
  });

  it("keeps a workflow version that still has runs, and says so", async () => {
    const { rows: [v2] } = await context.database.query<{ id: string }>(
      `SELECT id FROM totalbase.workflows_versions WHERE workflow = $1 AND version = 2`,
      [workflowId],
    );
    await context.database.query(
      `INSERT INTO totalbase.workflows_runs (id, workflow, version, trigger, mode, status, executor, history_enabled, history_level, expires_at)
       VALUES ($1, $2, $3, 'MANUAL', 'PRODUCTION', 'SUCCEEDED', '{}'::jsonb, true, 'SUMMARY', now() + interval '1 day')`,
      [randomUUID(), workflowId, v2!.id],
    );
    const res = await remove("workflows", workflowId, "4");
    expect([res.statusCode, res.json().data]).toEqual([200, { deleted: [1, 3], kept: [{ version: 2, runs: 1 }] }]);
    const { rows } = await context.database.query(`SELECT 1 FROM totalbase.workflows_runs WHERE workflow = $1`, [workflowId]);
    expect(rows).toHaveLength(1);
  });

  it("audits a deletion with the versions it removed", async () => {
    const { rows } = await context.database.query<{ metadata: { versionsDeleted?: { versions: number[] } } }>(
      `SELECT metadata FROM totalbase.logs WHERE action = 'DELETE' AND metadata->'versionsDeleted'->>'workflows' = $1 ORDER BY created_at DESC LIMIT 1`,
      [workflowId],
    );
    expect(rows[0]?.metadata.versionsDeleted?.versions).toEqual([1, 3]);
  });

  it("refuses a bad `before` and answers 404 for an unknown object", async () => {
    expect((await remove("dashboards", dashboardId, "abc")).statusCode).toBe(400);
    expect((await remove("dataviews", randomUUID(), "2")).statusCode).toBe(404);
    expect((await remove("workflows", randomUUID(), "2")).statusCode).toBe(404);
  });
});
