import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMaintenanceOverview, listMaintenanceIndexes, resolveMaintenanceTarget } from "./maintenance-stats.js";

const TABLE = "maintenance_stats_test_t";

describe("maintenance stats (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`CREATE TABLE public.${TABLE} (id int PRIMARY KEY, label text)`);
    await database.query(`CREATE INDEX ${TABLE}_label_idx ON public.${TABLE} (label)`);
    await database.query(`INSERT INTO public.${TABLE} SELECT g, 'row ' || g FROM generate_series(1, 500) g`);
    await database.query(`ANALYZE public.${TABLE}`);
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.close();
  });

  it("reports a table's size, rows, owner and that the configured role may maintain what it created", async () => {
    const overview = await getMaintenanceOverview(database);
    expect(overview.sizeBytes).toBeGreaterThan(0);
    expect(overview.version).toMatch(/^\d+/);
    const table = overview.tables.find((t) => t.schema === "public" && t.name === TABLE)!;
    expect(table).toMatchObject({ kind: "TABLE", estimatedRows: 500, canMaintain: true });
    expect(table.totalBytes).toBe(table.tableBytes + table.indexBytes + table.toastBytes);
    expect(table.indexBytes).toBeGreaterThan(0);
    expect(table.lastAnalyze).toBeInstanceOf(Date);
    // PostgreSQL's own schemas stay out.
    expect(overview.tables.some((t) => t.schema === "pg_catalog" || t.schema === "information_schema")).toBe(false);
  });

  it("lists the table's indexes, primary key flagged", async () => {
    const { oid } = (await getMaintenanceOverview(database)).tables.find((t) => t.name === TABLE)!;
    const indexes = await listMaintenanceIndexes(database, oid);
    expect(indexes.map((i) => i.name).sort()).toEqual([`${TABLE}_label_idx`, `${TABLE}_pkey`].sort());
    expect(indexes.find((i) => i.name === `${TABLE}_pkey`)).toMatchObject({ primary: true, unique: true, valid: true });
    await expect(listMaintenanceIndexes(database, 1)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  // TotalBase never requires superuser (AGENTS.md 4A): with an ordinary
  // role, only what it owns - or, on PostgreSQL 17+, holds MAINTAIN on -
  // can be maintained. The test database's own role may be a superuser,
  // so this connects as a throwaway ordinary one.
  describe("as a role without superuser", () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const ROLE = `tb_maint_probe_${suffix}`;
    const OWN = `maintenance_probe_own_${suffix}`;
    const FOREIGN = `maintenance_probe_foreign_${suffix}`;
    let probe: Database;
    let version = 0;

    beforeAll(async () => {
      version = (await database.query<{ v: number }>(`SELECT current_setting('server_version_num')::int AS v`)).rows[0]!.v;
      await database.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER`);
      await database.query(`CREATE TABLE public.${OWN} (id int PRIMARY KEY)`);
      await database.query(`ALTER TABLE public.${OWN} OWNER TO ${ROLE}`);
      await database.query(`CREATE TABLE public.${FOREIGN} (id int PRIMARY KEY)`);
      probe = new Database({ ...loadDatabaseConfigFromEnv(), user: ROLE, password: ROLE });
    });

    afterAll(async () => {
      await probe.close();
      await database.query(`DROP TABLE IF EXISTS public.${OWN}, public.${FOREIGN}`);
      await database.query(`DROP OWNED BY ${ROLE}`);
      await database.query(`DROP ROLE IF EXISTS ${ROLE}`);
    });

    it("may maintain only the tables it owns", async () => {
      const tables = (await getMaintenanceOverview(probe)).tables;
      expect(tables.find((t) => t.name === OWN)).toMatchObject({ canMaintain: true, owner: ROLE });
      expect(tables.find((t) => t.name === FOREIGN)?.canMaintain).toBe(false);

      const foreignOid = tables.find((t) => t.name === FOREIGN)!.oid;
      expect(await resolveMaintenanceTarget(probe, foreignOid)).toMatchObject({ canMaintain: false });
    });

    it("may maintain another role's table once granted MAINTAIN (PostgreSQL 17+)", async () => {
      if (version < 170000) return; // MAINTAIN doesn't exist before 17: owner only.
      await database.query(`GRANT MAINTAIN ON public.${FOREIGN} TO ${ROLE}`);
      const foreignOid = (await getMaintenanceOverview(probe)).tables.find((t) => t.name === FOREIGN)!.oid;
      expect(await resolveMaintenanceTarget(probe, foreignOid)).toMatchObject({ canMaintain: true });
      await database.query(`REVOKE MAINTAIN ON public.${FOREIGN} FROM ${ROLE}`);
    });
  });
});

