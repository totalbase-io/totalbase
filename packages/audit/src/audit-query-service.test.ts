import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_COUNT_CAP, AuditQueryService } from "./audit-query-service.js";
import { AuditService } from "./audit-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const REQUEST_IDS = [
  "aaaaaaaa-0000-0000-0000-000000000001",
  "aaaaaaaa-0000-0000-0000-000000000002",
  "aaaaaaaa-0000-0000-0000-000000000003",
];
/** Access events for the event / prefix filters - one request id per entry, all cleaned up in afterAll. */
const EVENT_REQUEST_PREFIX = "aaaaaaaa-0000-0000-0001-";
const EVENTS: Array<{ event: string; status: "EXECUTED" | "DENIED" }> = [
  { event: "permission.set", status: "EXECUTED" },
  { event: "permission.clear", status: "EXECUTED" },
  { event: "role.create", status: "EXECUTED" },
  { event: "user.roles_set", status: "EXECUTED" },
  { event: "auth.login", status: "DENIED" },
  // Would match "permission.*" if "." were a wildcard, or "perm_ssion.*" if "_" were.
  { event: "permissionXset", status: "EXECUTED" },
  { event: "permission.set", status: "DENIED" },
];
/** A principal id no other test uses - scopes the count-cap and facet tests to their own rows. */
const BULK_PRINCIPAL = "aaaaaaaa-0000-0000-0002-000000000001";

describe("AuditQueryService (integration)", () => {
  let database: Database;
  let audit: AuditService;
  let auditQuery: AuditQueryService;
  let resourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    const settings = new SettingsService(database);
    audit = new AuditService(settings);
    auditQuery = new AuditQueryService(database);

    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (900301, 'public', 'audit_query_pkg_test_resource', 'TABLE', 'ACTIVE')
       RETURNING id`,
    );
    resourceId = rows[0]!.id;

    await audit.record(database, {
      requestId: REQUEST_IDS[0]!,
      principal: { type: "USER", id: null },
      resourceId,
      action: "CREATE",
      status: "EXECUTED",
      source: "api",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await audit.record(database, {
      requestId: REQUEST_IDS[1]!,
      principal: { type: "SYSTEM", id: null },
      resourceId,
      action: "DELETE",
      status: "FAILED",
      source: "api",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await audit.record(database, {
      requestId: REQUEST_IDS[2]!,
      principal: { type: "SYSTEM", id: null },
      action: "AUTH",
      status: "DENIED",
      source: "api",
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    for (const [index, { event, status }] of EVENTS.entries()) {
      await audit.record(database, {
        requestId: `${EVENT_REQUEST_PREFIX}${String(index).padStart(12, "0")}`,
        principal: { type: "ADMIN", id: BULK_PRINCIPAL },
        action: "AUTH",
        status,
        source: "admin",
        metadata: { event },
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE request_id = ANY($1)`, [REQUEST_IDS]);
    await database.query(`DELETE FROM totalbase.logs WHERE principal = $1`, [BULK_PRINCIPAL]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.close();
  });

  it("filters by resource and returns a total count", async () => {
    const { data, total } = await auditQuery.list({ resourceId });
    expect(total).toBeGreaterThanOrEqual(2);
    expect(data.every((entry) => entry.resource === resourceId)).toBe(true);
  });

  it("filters by status", async () => {
    const { data } = await auditQuery.list({ resourceId, status: "FAILED" });
    expect(data.map((e) => e.requestId)).toEqual([REQUEST_IDS[1]]);
  });

  it("gets a single entry by id and 404s for an unknown id", async () => {
    const { data } = await auditQuery.list({ resourceId, limit: 1 });
    const entry = await auditQuery.get(data[0]!.id);
    expect(entry.id).toBe(data[0]!.id);
    await expect(auditQuery.get("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("supports resource-less entries (AUTH events)", async () => {
    const { data } = await auditQuery.list({ principalType: "SYSTEM", action: "AUTH" });
    expect(data.some((e) => e.requestId === REQUEST_IDS[2])).toBe(true);
    expect(data.find((e) => e.requestId === REQUEST_IDS[2])?.resource).toBeNull();
  });

  it("recentActivity returns entries ordered newest first", async () => {
    const activity = await auditQuery.recentActivity(5);
    expect(activity.length).toBeGreaterThan(0);
    for (let i = 1; i < activity.length; i++) {
      expect(activity[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(activity[i]!.createdAt.getTime());
    }
  });

  it("filters by several actions and statuses at once", async () => {
    const { data } = await auditQuery.list({ resourceId, action: ["CREATE", "DELETE"] });
    expect(data.map((e) => e.requestId).sort()).toEqual([REQUEST_IDS[0], REQUEST_IDS[1]]);
    const statuses = await auditQuery.list({ resourceId, status: ["EXECUTED", "FAILED"] });
    expect(statuses.total).toBe(2);
  });

  it("filters by request id", async () => {
    const { data } = await auditQuery.list({ requestId: REQUEST_IDS[1] });
    expect(data.map((e) => e.action)).toEqual(["DELETE"]);
  });

  it("matches events exactly, and by prefix with a trailing .*", async () => {
    const scoped = { principalId: BULK_PRINCIPAL };
    const events = async (event: string[]) =>
      (await auditQuery.list({ ...scoped, event })).data.map((e) => (e.metadata as { event: string }).event).sort();

    expect(await events(["role.create"])).toEqual(["role.create"]);
    expect(await events(["permission.*"])).toEqual(["permission.clear", "permission.set", "permission.set"]);
    expect(await events(["permission.*", "user.roles_set"])).toEqual([
      "permission.clear", "permission.set", "permission.set", "user.roles_set",
    ]);
  });

  it("treats LIKE wildcards in an event prefix literally", async () => {
    const { total } = await auditQuery.list({ principalId: BULK_PRINCIPAL, event: ["perm_ssion.*"] });
    expect(total).toBe(0);
    const percent = await auditQuery.list({ principalId: BULK_PRINCIPAL, event: ["%.*"] });
    expect(percent.total).toBe(0);
  });

  it("never interpolates filter values into SQL", async () => {
    const injected = "x' OR '1'='1";
    await expect(auditQuery.list({ event: [injected] })).resolves.toMatchObject({ total: 0 });
    await expect(auditQuery.list({ action: [injected, "AUTH' --"] })).resolves.toMatchObject({ total: 0 });
    await expect(auditQuery.summary({ status: injected })).resolves.toMatchObject({ byAction: {}, byPrincipalType: {} });
  });

  it("summary counts each facet without its own filter but with every other one", async () => {
    const summary = await auditQuery.summary({ principalId: BULK_PRINCIPAL, status: "DENIED" });
    // Status ignores status=DENIED: every status of this principal's entries.
    expect(summary.byStatus).toEqual({ EXECUTED: 5, DENIED: 2 });
    // The other facets honor it: only the two DENIED entries.
    expect(summary.byAction).toEqual({ AUTH: 2 });
    expect(summary.byPrincipalType).toEqual({ ADMIN: 2 });
  });

  it("caps the total past AUDIT_COUNT_CAP instead of counting every row", async () => {
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, principal, action, status, source, started_at)
       SELECT gen_random_uuid(), 'ADMIN', $1, 'EXPORT', 'EXECUTED', 'admin', now()
       FROM generate_series(1, $2::int)`,
      [BULK_PRINCIPAL, AUDIT_COUNT_CAP + 5],
    );
    const capped = await auditQuery.list({ principalId: BULK_PRINCIPAL, action: "EXPORT", limit: 1 });
    expect(capped).toMatchObject({ total: AUDIT_COUNT_CAP, totalCapped: true });
    expect(capped.data).toHaveLength(1);

    const exact = await auditQuery.list({ principalId: BULK_PRINCIPAL, action: "AUTH" });
    expect(exact).toMatchObject({ total: EVENTS.length, totalCapped: false });
  });
});
