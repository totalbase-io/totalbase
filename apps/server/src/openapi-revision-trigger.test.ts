import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/**
 * The OpenAPI revision triggers: every
 * write to a table the generated Data API document is built from logs one
 * OPENAPI row in `totalbase.invalidations` - one per statement, whatever
 * it touched - so openapi-cache.ts sees the change whoever made it. A
 * workflow's bookkeeping (`consecutive_failures`, which the document doesn't
 * show) logs nothing; what the document shows (name, slug, enabled...) does.
 */
describe("OpenAPI revision trigger (integration)", () => {
  const suffix = Date.now().toString(36);
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const roleIds: string[] = [];
  let workflowId: string | undefined;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
  });

  afterAll(async () => {
    if (workflowId) await context.workflowsAdmin.remove(workflowId);
    if (roleIds.length) await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [roleIds]);
    await app.close();
    await database.close();
  });

  /** OPENAPI changes logged so far - the deltas below are what each statement adds. */
  async function changes(): Promise<number> {
    const { rows } = await database.query<{ count: string }>(`SELECT count(*) AS count FROM totalbase.invalidations WHERE topic = 'OPENAPI'`);
    return Number(rows[0]!.count);
  }

  it("logs one change per statement on a tracked table, whatever the statement touched", async () => {
    // One transaction, counting only the rows it wrote itself (xmin = this transaction): the server's own timers
    // (a catalog sync touching tracked tables) log OPENAPI rows of their own meanwhile.
    await database.transaction(async (client) => {
      const count = async () => Number((await client.query<{ count: string }>(`SELECT count(*) AS count FROM totalbase.invalidations WHERE topic = 'OPENAPI' AND xmin = txid_current()::text::xid`)).rows[0]!.count);
      const before = await count();
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO totalbase.roles (name) VALUES ($1), ($2) RETURNING id`,
        [`openapi-revision-${suffix}-a`, `openapi-revision-${suffix}-b`],
      );
      const ids = rows.map((row) => row.id);
      expect(await count()).toBe(before + 1);

      await client.query(`UPDATE totalbase.roles SET active = false WHERE id = ANY($1::uuid[])`, [ids]);
      expect(await count()).toBe(before + 2);

      await client.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [ids]);
      // The roles' own statement, plus one per tracked table the delete cascades into (permissions, capabilities,
      // workflows_roles - a statement-level trigger fires even when the cascade touches no row).
      expect(await count()).toBeGreaterThanOrEqual(before + 3);
    });
  });

  it("logs nothing for a workflow's run bookkeeping, and a change for what the document shows", async () => {
    const workflow = await context.workflowsAdmin.create({ name: `openapi rev ${suffix}`, slug: `openapi-revision-${suffix}` });
    workflowId = workflow.id;

    const before = await changes();
    await database.query(`UPDATE totalbase.workflows SET consecutive_failures = consecutive_failures + 1 WHERE id = $1`, [workflowId]);
    expect(await changes()).toBe(before);

    await database.query(`UPDATE totalbase.workflows SET name = $2 WHERE id = $1`, [workflowId, `openapi rev ${suffix} renamed`]);
    expect(await changes()).toBe(before + 1);

    await database.query(`UPDATE totalbase.workflows SET enabled = NOT enabled WHERE id = $1`, [workflowId]);
    expect(await changes()).toBe(before + 2);
  });
});
