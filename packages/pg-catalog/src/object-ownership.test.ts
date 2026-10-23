import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFunctionOwnership, getRelationOwnership } from "./object-ownership.js";

// TotalBase never requires superuser (AGENTS.md 4A): an ordinary role may
// alter only what it owns, directly or through membership of the owner
// role. The test database's own role may be a superuser, so the checks
// connect as a throwaway ordinary one.
describe("object ownership (integration)", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const ROLE = `tb_alter_probe_${suffix}`;
  const OWNER_GROUP = `tb_alter_group_${suffix}`;
  const OWN = `alter_probe_own_${suffix}`;
  const FOREIGN = `alter_probe_foreign_${suffix}`;
  const VIA_GROUP = `alter_probe_group_${suffix}`;
  const FOREIGN_FN = `alter_probe_fn_${suffix}`;
  let database: Database;
  let probe: Database;
  const oidOf = async (sql: string) => (await database.query<{ oid: number }>(sql)).rows[0]!.oid;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER`);
    await database.query(`CREATE ROLE ${OWNER_GROUP} NOLOGIN`);
    await database.query(`GRANT ${OWNER_GROUP} TO ${ROLE}`);
    // Giving a table to a role needs membership in it, which CREATEROLE grants itself, and the role's CREATE on the
    // schema - no superuser (test-matrix.sh).
    await database.query(`GRANT ${ROLE}, ${OWNER_GROUP} TO CURRENT_USER`);
    await database.query(`GRANT CREATE ON SCHEMA public TO ${ROLE}, ${OWNER_GROUP}`);
    await database.query(`CREATE TABLE public.${OWN} (id int PRIMARY KEY)`);
    await database.query(`ALTER TABLE public.${OWN} OWNER TO ${ROLE}`);
    await database.query(`CREATE TABLE public.${FOREIGN} (id int PRIMARY KEY)`);
    await database.query(`CREATE TABLE public.${VIA_GROUP} (id int PRIMARY KEY)`);
    await database.query(`ALTER TABLE public.${VIA_GROUP} OWNER TO ${OWNER_GROUP}`);
    await database.query(`CREATE FUNCTION public.${FOREIGN_FN}() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    probe = new Database({ ...loadDatabaseConfigFromEnv(), user: ROLE, password: ROLE });
  });

  afterAll(async () => {
    await probe.close();
    await database.query(`DROP TABLE IF EXISTS public.${OWN}, public.${FOREIGN}, public.${VIA_GROUP}`);
    await database.query(`DROP FUNCTION IF EXISTS public.${FOREIGN_FN}()`);
    await database.query(`DROP OWNED BY ${ROLE}, ${OWNER_GROUP}`);
    await database.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await database.query(`DROP ROLE IF EXISTS ${OWNER_GROUP}`);
    await database.close();
  });

  it("may alter a table it owns or whose owner role it belongs to, not another role's", async () => {
    expect(await getRelationOwnership(probe, await oidOf(`SELECT 'public.${OWN}'::regclass::oid AS oid`))).toEqual({ owner: ROLE, canAlter: true });
    expect(await getRelationOwnership(probe, await oidOf(`SELECT 'public.${VIA_GROUP}'::regclass::oid AS oid`))).toEqual({ owner: OWNER_GROUP, canAlter: true });
    const foreign = await getRelationOwnership(probe, await oidOf(`SELECT 'public.${FOREIGN}'::regclass::oid AS oid`));
    expect(foreign.canAlter).toBe(false);
    expect(foreign.owner).not.toBe(ROLE);
  });

  it("a NOINHERIT membership doesn't count - PostgreSQL would need a SET ROLE first", async () => {
    const viaGroup = await oidOf(`SELECT 'public.${VIA_GROUP}'::regclass::oid AS oid`);
    // PostgreSQL 16+ fixes INHERIT per grant; 15 reads the role's attribute.
    const version = (await database.query<{ v: number }>(`SELECT current_setting('server_version_num')::int AS v`)).rows[0]!.v;
    const noInherit = version >= 160000 ? `GRANT ${OWNER_GROUP} TO ${ROLE} WITH INHERIT FALSE` : `ALTER ROLE ${ROLE} NOINHERIT`;
    const inherit = version >= 160000 ? `GRANT ${OWNER_GROUP} TO ${ROLE} WITH INHERIT TRUE` : `ALTER ROLE ${ROLE} INHERIT`;
    await database.query(noInherit);
    try {
      expect(await getRelationOwnership(probe, viaGroup)).toEqual({ owner: OWNER_GROUP, canAlter: false });
      await expect(probe.query(`ALTER TABLE public.${VIA_GROUP} ADD COLUMN y int`)).rejects.toMatchObject({ code: "INSUFFICIENT_PRIVILEGE" });
    } finally {
      await database.query(inherit);
    }
  });

  it("agrees with PostgreSQL, which still decides: ALTER on the foreign table fails", async () => {
    await expect(probe.query(`ALTER TABLE public.${FOREIGN} ADD COLUMN x int`)).rejects.toMatchObject({ code: "INSUFFICIENT_PRIVILEGE" });
    await probe.query(`ALTER TABLE public.${OWN} ADD COLUMN x int`);
  });

  it("reports a function's owner the same way", async () => {
    const fn = await getFunctionOwnership(probe, await oidOf(`SELECT 'public.${FOREIGN_FN}()'::regprocedure::oid AS oid`));
    expect(fn.canAlter).toBe(false);
    expect(await getFunctionOwnership(database, await oidOf(`SELECT 'public.${FOREIGN_FN}()'::regprocedure::oid AS oid`))).toMatchObject({ canAlter: true });
  });

  it("RESOURCE_NOT_FOUND for an OID that doesn't exist", async () => {
    await expect(getRelationOwnership(probe, 1)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(getFunctionOwnership(probe, 1)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});
