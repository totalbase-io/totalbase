import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditInsightsService } from "./audit-insights-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
/** Every row this file writes carries this request id prefix - cleaned up in afterAll. */
const REQUEST_PREFIX = "bbbbbbbb-0000-0000-0000-";

describe("AuditInsightsService (integration)", () => {
  let database: Database;
  let insights: AuditInsightsService;
  let seq = 0;

  async function log(row: {
    action: string; status: string; at: string; principal?: string; event?: string; reason?: string; resource?: string;
    source?: string; errorCode?: string; rowCount?: number;
  }) {
    seq += 1;
    const metadata = {
      ...(row.event && { event: row.event }),
      ...(row.reason && { reason: row.reason }),
      ...(row.rowCount !== undefined && { rowCount: row.rowCount }),
    };
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, principal, action, status, source, resource, metadata, error_code, started_at, created_at)
       VALUES ($1, 'ADMIN', $2, $3, $4, $5, $6, $7, $8, ${row.at}, ${row.at})`,
      [
        `${REQUEST_PREFIX}${String(seq).padStart(12, "0")}`, row.principal ?? null, row.action, row.status,
        row.source ?? "admin", row.resource ?? null, JSON.stringify(metadata), row.errorCode ?? null,
      ],
    );
  }

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    await database.query(`DELETE FROM totalbase.resources WHERE postgres_oid = 900401`);
    insights = new AuditInsightsService(database);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE request_id::text LIKE $1`, [`${REQUEST_PREFIX}%`]);
    await database.query(`DELETE FROM totalbase.resources WHERE postgres_oid = 900401`);
    await database.close();
  });

  it("counts sign-ins per day, weekday and hour in the viewer's time zone, and failures by reason", async () => {
    // Two days ago, twelve hours away from now: no sign-in happening while
    // this runs can land in the same day or hour bucket.
    const { rows } = await database.query<{ at: Date }>(`SELECT date_trunc('hour', now() - interval '2 days' - interval '12 hours') AS at`);
    const at = rows[0]!.at;
    const atSql = `'${at.toISOString()}'::timestamptz`;
    const window = { days: 7, timeZone: "UTC" };
    const before = await insights.signIns(window);
    const beforeBa = await insights.signIns({ days: 7, timeZone: "America/Argentina/Buenos_Aires" });

    for (let i = 0; i < 3; i += 1) await log({ action: "AUTH", status: "EXECUTED", event: "auth.portal_login", at: atSql });
    await log({ action: "AUTH", status: "DENIED", event: "auth.login", reason: "wrong_password", at: atSql });
    await log({ action: "AUTH", status: "EXECUTED", event: "user.create", at: atSql }); // not a sign-in

    const after = await insights.signIns(window);
    const day = at.toISOString().slice(0, 10);
    const dayDelta = (s: typeof after) => s.perDay.find((d) => d.day === day)!;
    expect(dayDelta(after).succeeded - dayDelta(before).succeeded).toBe(3);
    expect(dayDelta(after).failed - dayDelta(before).failed).toBe(1);
    expect(after.perDay).toHaveLength(7);

    const isoWeekday = ((at.getUTCDay() + 6) % 7);
    expect(after.byWeekday[isoWeekday]! - before.byWeekday[isoWeekday]!).toBe(3);
    expect(after.byHour[at.getUTCHours()]! - before.byHour[at.getUTCHours()]!).toBe(3);
    const wrong = (s: typeof after) => s.failuresByReason.find((r) => r.reason === "wrong_password")?.count ?? 0;
    expect(wrong(after) - wrong(before)).toBe(1);

    // Buenos Aires is UTC-3: the same sign-ins fall three hours earlier.
    const afterBa = await insights.signIns({ days: 7, timeZone: "America/Argentina/Buenos_Aires" });
    const baHour = (at.getUTCHours() + 21) % 24;
    expect(afterBa.byHour[baHour]! - beforeBa.byHour[baHour]!).toBe(3);
  });

  it("scopes activity to the given principals, per day and category", async () => {
    const principal = randomUUID();
    await log({ action: "CREATE", status: "EXECUTED", principal, at: "now()" });
    await log({ action: "UPDATE", status: "EXECUTED", principal, at: "now()" });
    await log({ action: "SQL_EXECUTE", status: "FAILED", principal, at: "now()" });
    await log({ action: "AUTH", status: "DENIED", event: "permission.set", principal, at: "now()" });
    await log({ action: "EXPORT", status: "EXECUTED", principal, at: "now() - interval '40 days'" }); // outside 30 days

    const result = await insights.activity({ days: 30, timeZone: "UTC", principalIds: [principal] });
    expect(result.totals).toEqual({ actions: 4, writes: 2, denied: 1, failed: 1 });
    expect(result.perDay).toHaveLength(30);
    const today = result.perDay.at(-1)!;
    expect(today).toMatchObject({ data: 2, access: 1, sql: 1, bulk: 0, other: 0 });
    expect(result.topActions.map((a) => a.action).sort()).toEqual(["CREATE", "SQL_EXECUTE", "UPDATE", "permission.set"]);
    expect(result.writesPerDay.at(-1)).toMatchObject({ create: 1, update: 1, delete: 0 });
    expect(result.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(4);
    expect(result.topPrincipals).toEqual([]); // scoped: who acted is already known
  });

  it("breaks activity down by source, failure code and rows moved out", async () => {
    const principal = randomUUID();
    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (900401, 'public', 'insights_test_resource', 'TABLE', 'ACTIVE') RETURNING id`,
    );
    const resource = resourceRows[0]!.id;
    await log({ action: "UPDATE", status: "EXECUTED", principal, source: "api", at: "now()" });
    await log({ action: "UPDATE", status: "DENIED", principal, source: "api", errorCode: "PERMISSION_DENIED", at: "now()" });
    await log({ action: "CREATE", status: "FAILED", principal, source: "workflow", errorCode: "UNIQUE_VIOLATION", at: "now()" });
    await log({ action: "EXPORT", status: "EXECUTED", principal, resource, rowCount: 1200, at: "now()" });
    await log({ action: "EXPORT", status: "EXECUTED", principal, resource, rowCount: 300, at: "now()" });
    await log({ action: "IMPORT", status: "EXECUTED", principal, resource, rowCount: 40, at: "now()" });

    const result = await insights.activity({ days: 7, timeZone: "UTC", principalIds: [principal] });
    expect(Object.fromEntries(result.bySource.map((s) => [s.source, s.count]))).toEqual({ api: 2, workflow: 1, admin: 3 });
    expect(result.failures.map((f) => [f.code, f.count]).sort()).toEqual([["PERMISSION_DENIED", 1], ["UNIQUE_VIOLATION", 1]]);
    expect(result.dataOut).toEqual([{ resource, exported: 1500, imported: 40, printed: 0, operations: 3 }]);

    const everyone = await insights.activity({ days: 7, timeZone: "UTC" });
    expect(everyone.topPrincipals.length).toBeGreaterThan(0);
  });

  it("rejects an unknown time zone and an out-of-range window; accepts legacy aliases browsers report", async () => {
    await expect(insights.signIns({ days: 7, timeZone: "Mars/Olympus" })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    // A zone this PostgreSQL may not know, with the browser's offset: the
    // offset is used - and matches the canonical zone's hour buckets.
    const alias = await insights.signIns({ days: 7, timeZone: "Not/AZone", utcOffsetMinutes: -180 });
    const canonical = await insights.signIns({ days: 7, timeZone: "America/Argentina/Buenos_Aires" });
    expect(alias.timeZone).toBe("UTC-03:00");
    expect(alias.byHour).toEqual(canonical.byHour);
    await expect(insights.activity({ days: 0, timeZone: "UTC" })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(insights.activity({ days: 400, timeZone: "UTC" })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });
});
