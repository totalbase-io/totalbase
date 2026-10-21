import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { junctionLink } from "./junction.js";
import { getRelationDetail } from "./relation-detail.js";

const P = "junction_test";

/** A junction table recognized from PostgreSQL's catalog (DataViews.md §8.5, Administration.md §3.4). */
describe("junctionLink (integration)", () => {
  let database: Database;
  const detail = async (table: string) =>
    getRelationDetail(database, (await database.query<{ oid: number }>(`SELECT to_regclass($1)::oid::int AS oid`, [`public.${table}`])).rows[0]!.oid);
  const projects = { schema: "public", table: `${P}_projects` };

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP TABLE IF EXISTS public.${P}_links, public.${P}_roles, public.${P}_loose, public.${P}_friends, public.${P}_projects, public.${P}_techs CASCADE`);
    await database.query(`CREATE TABLE public.${P}_projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    await database.query(`CREATE TABLE public.${P}_techs (id integer PRIMARY KEY, name text)`);
    // As New table › Junction table creates it.
    await database.query(`CREATE TABLE public.${P}_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project uuid NOT NULL REFERENCES public.${P}_projects (id) ON DELETE CASCADE,
      tech integer NOT NULL REFERENCES public.${P}_techs (id) ON DELETE CASCADE, UNIQUE (tech, project))`);
    // A column of its own: rows, not links.
    await database.query(`CREATE TABLE public.${P}_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project uuid NOT NULL REFERENCES public.${P}_projects (id), tech integer NOT NULL REFERENCES public.${P}_techs (id),
      role text, UNIQUE (project, tech))`);
    // No UNIQUE over the pair.
    await database.query(`CREATE TABLE public.${P}_loose (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project uuid NOT NULL REFERENCES public.${P}_projects (id), tech integer NOT NULL REFERENCES public.${P}_techs (id))`);
    // Both keys at the same table.
    await database.query(`CREATE TABLE public.${P}_friends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      a uuid NOT NULL REFERENCES public.${P}_projects (id), b uuid NOT NULL REFERENCES public.${P}_projects (id), UNIQUE (a, b))`);
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${P}_links, public.${P}_roles, public.${P}_loose, public.${P}_friends, public.${P}_projects, public.${P}_techs CASCADE`);
    await database.close();
  });

  it("links the record's table to the other one, from either side", async () => {
    const links = await detail(`${P}_links`);
    expect(junctionLink(links, projects)).toEqual({ primaryKey: "id", column: "project", otherColumn: "tech", target: { schema: "public", table: `${P}_techs`, column: "id" } });
    expect(junctionLink(links, { schema: "public", table: `${P}_techs` })).toMatchObject({ column: "tech", otherColumn: "project", target: { table: `${P}_projects` } });
  });

  it("is none for a table it doesn't link, one with columns of its own, without a UNIQUE pair, or with both keys at one table", async () => {
    expect(junctionLink(await detail(`${P}_links`), { schema: "public", table: "elsewhere" })).toBeNull();
    expect(junctionLink(await detail(`${P}_roles`), projects)).toBeNull();
    expect(junctionLink(await detail(`${P}_loose`), projects)).toBeNull();
    expect(junctionLink(await detail(`${P}_friends`), projects)).toBeNull();
    expect(junctionLink(await detail(`${P}_projects`), projects)).toBeNull();
  });
});
