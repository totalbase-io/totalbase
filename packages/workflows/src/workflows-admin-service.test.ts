import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowsAdminService } from "./workflows-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const accept = () => {};

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof TotalBaseError && error.code === code);
}

/** A definition with one Start plus a labelled marker node, so versions are easy to tell apart. */
function definitionWith(marker: string): Record<string, unknown> {
  return {
    operations: [
      { id: "start", type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration: { trigger: "MANUAL" } },
      { id: "marker", type: "totalbase.finish-result", configuration_version: 1, label: marker, key: "finish", configuration: {} },
    ],
    connections: [{ source: "start", target: "marker", output: "next" }],
  };
}
const markerOf = (definition: Record<string, unknown>) => (definition.operations as { label: string }[])[1]?.label;

describe("WorkflowsAdminService versioning (integration, Specification.md §13)", () => {
  let database: Database;
  let workflows: WorkflowsAdminService;
  let id: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    workflows = new WorkflowsAdminService(database);
    await database.query(`DELETE FROM totalbase.workflows WHERE slug LIKE 'workflows-pkg-test%'`);
    id = (await workflows.create({ name: "workflows pkg test", slug: "workflows-pkg-test" })).id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.workflows WHERE slug LIKE 'workflows-pkg-test%'`);
    await database.close();
  });

  it("creates a draft only - unpublished, not activatable", async () => {
    const created = await workflows.get(id);
    expect(created.publishedVersion).toBeNull();
    expect(created.liveVersion).toBeNull();
    expect(created.hasUnpublishedChanges).toBe(true);
    await expectCode(workflows.update(id, { revision: created.revision, enabled: true }), "WORKFLOW_NOT_ACTIVATABLE");
    await expectCode(workflows.getPublished(id), "WORKFLOW_NOT_FOUND");
  });

  it("publishes the draft as v1; an unchanged re-publish is a no-op answering the live version", async () => {
    let wf = await workflows.get(id);
    await workflows.saveDraft(id, wf.revision, definitionWith("one"));
    wf = await workflows.get(id);
    wf = await workflows.publish(id, wf.revision, accept);
    expect(wf.liveVersion).toBe(1);
    expect(wf.hasUnpublishedChanges).toBe(false);
    expect(markerOf((await workflows.getPublished(id)).definition)).toBe("one");
    const again = await workflows.publish(id, wf.revision, () => { throw new Error("readiness must not run for a no-op publish"); });
    expect([again.liveVersion, again.revision, again.hasUnpublishedChanges]).toEqual([1, wf.revision, false]);
    expect(await workflows.listVersions(id)).toHaveLength(1);
    // A stale revision is still a conflict, no-op or not.
    await expectCode(workflows.publish(id, "0", accept), "WORKFLOW_REVISION_CONFLICT");
  });

  it("refuses to save or create a definition that breaks the graph rules", async () => {
    const wf = await workflows.get(id);
    const broken = definitionWith("broken") as { operations: Record<string, unknown>[]; connections: Record<string, unknown>[] };
    broken.connections.push({ source: "marker", target: "start", output: "next" });
    await expectCode(workflows.saveDraft(id, wf.revision, broken), "WORKFLOW_INVALID_DESIGN");
    await expectCode(workflows.create({ name: "workflows pkg test broken", slug: "workflows-pkg-test-broken", definition: broken }), "WORKFLOW_INVALID_DESIGN");
    expect((await workflows.get(id)).revision).toBe(wf.revision);

    // Publish checks the graph again: a draft that got past save (written
    // straight to the table here) still cannot become a version.
    await database.query(`UPDATE totalbase.workflows SET definition = $2::jsonb WHERE id = $1`, [id, JSON.stringify(broken)]);
    await expectCode(workflows.publish(id, wf.revision, accept), "WORKFLOW_INVALID_DESIGN");
    expect((await workflows.listVersions(id)).map((v) => v.version)).toEqual([1]);
    await database.query(`UPDATE totalbase.workflows SET definition = $2::jsonb WHERE id = $1`, [id, JSON.stringify(definitionWith("one"))]);
  });

  it("keeps editing the draft without touching the live version", async () => {
    let wf = await workflows.get(id);
    await workflows.saveDraft(id, wf.revision, definitionWith("two"));
    wf = await workflows.get(id);
    expect(wf.hasUnpublishedChanges).toBe(true);
    expect(markerOf((await workflows.getPublished(id)).definition)).toBe("one");
    wf = await workflows.publish(id, wf.revision, accept);
    expect(wf.liveVersion).toBe(2);
    expect(markerOf((await workflows.getVersion(id, 1)).definition)).toBe("one");
  });

  it("rejects a stale revision", async () => {
    const wf = await workflows.get(id);
    await workflows.saveDraft(id, wf.revision, definitionWith("two"));
    await expectCode(workflows.saveDraft(id, wf.revision, definitionWith("stale")), "WORKFLOW_REVISION_CONFLICT");
  });

  it("restores an old version into the draft only - what runs changes on Publish", async () => {
    let wf = await workflows.get(id);
    await workflows.saveDraft(id, wf.revision, definitionWith("unpublished edit"));
    wf = await workflows.get(id);
    wf = await workflows.restore(id, wf.revision, 1);
    expect(markerOf((await workflows.getDraft(id)).definition)).toBe("one");
    expect(wf.liveVersion).toBe(2);
    expect(wf.hasUnpublishedChanges).toBe(true);
    expect(markerOf((await workflows.getPublished(id)).definition)).not.toBe("one");
    await expectCode(workflows.restore(id, "0", 1), "WORKFLOW_REVISION_CONFLICT");

    wf = await workflows.publish(id, wf.revision, accept);
    expect(wf.liveVersion).toBe(3);
    expect(wf.hasUnpublishedChanges).toBe(false);
    const published = await workflows.getPublished(id);
    expect(markerOf(published.definition)).toBe("one");
    const versions = await workflows.listVersions(id);
    expect(versions.map((v) => [v.version, v.restoredFromVersion])).toEqual([[3, 1], [2, null], [1, null]]);
    expect(published.workflow.publishedVersion).toBe(versions[0]!.id);
  });

  it("only lists enabled + published workflows for automatic admission", async () => {
    let wf = await workflows.get(id);
    expect((await workflows.listEnabledPublished()).some((w) => w.workflow.id === id)).toBe(false);
    wf = await workflows.update(id, { revision: wf.revision, enabled: true });
    const candidate = (await workflows.listEnabledPublished()).find((w) => w.workflow.id === id);
    expect(markerOf(candidate!.definition)).toBe("one");
    expect((await workflows.getEnabledPublishedBySlug("workflows-pkg-test"))?.workflow.id).toBe(id);
  });

  it("duplicates a version into a new, disabled, unpublished workflow", async () => {
    const copy = await workflows.duplicateVersion(id, 2, { name: "workflows pkg test copy", slug: "workflows-pkg-test-copy" });
    expect(copy.id).not.toBe(id);
    expect(copy.enabled).toBe(false);
    expect(copy.publishedVersion).toBeNull();
    expect(markerOf((await workflows.getDraft(copy.id)).definition)).toBe("two");
    expect(await workflows.listVersions(copy.id)).toEqual([]);
  });

  it("404s an unknown version", async () => {
    await expectCode(workflows.getVersion(id, 99), "WORKFLOW_NOT_FOUND");
  });
});
