import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

const RUN = Date.now().toString(36);
const BRANCHES = `ref_branches_${RUN}`;
const READINGS = `ref_readings_${RUN}`;
const VIEW = `ref_v_readings_${RUN}`;
const PASSWORD = "a-strong-enough-password";

/**
 * What a link filter's chip names a foreign key's value by (DB26): a view's column through the table column it is -
 * metadata only, for a column the viewer may read.
 */
describe("App DataView column reference (/app/api/dataviews/:slug/columns/:column/reference)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  let dataviewId: string;
  const ids = { roles: [] as string[], users: [] as string[], resources: [] as string[] };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`CREATE TABLE public.${BRANCHES} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    await database.query(`CREATE TABLE public.${READINGS} (id serial PRIMARY KEY, branch uuid REFERENCES public.${BRANCHES}(id), secret text)`);
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT id, branch, secret FROM public.${READINGS}`);
    const resource = async (name: string, type: string) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, $3, 'ACTIVE', ARRAY['GET']) RETURNING id`,
      [`public.${name}`, name, type],
    )).rows[0]!.id;
    const branches = await resource(BRANCHES, "TABLE");
    const view = await resource(VIEW, "VIEW");
    ids.resources.push(branches, view);
    await database.query(`UPDATE totalbase.resources SET row_presentation = '{"displayField": "name"}' WHERE id = $1`, [branches]);
    const role = (await context.roles.create(`ref-viewer-${RUN}`, { appAccess: true })).id;
    ids.roles.push(role);
    await context.permissions.set(role, view, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }, { field: "branch", effect: "ALLOW" }] });
    const user = await context.auth.users.create({ email: `ref-${RUN}@example.com`, name: "x", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    ids.users.push(user.id);
    await context.roleAssignments.assignRoleToUser(user.id, role);
    token = (await context.auth.login({ email: `ref-${RUN}@example.com`, password: PASSWORD })).token;
    dataviewId = (await context.dataviewsAdmin.create({ name: `Ref ${RUN}`, slug: `ref-${RUN}`, sourceResourceId: view, viewType: "TABLE" })).id;
    await context.dataviewsAdmin.setRoles(dataviewId, [role]);
    await context.dataviewsAdmin.publish(dataviewId, null);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataviewId]);
    for (const id of ids.users) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of ids.roles) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    for (const id of ids.resources) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${READINGS}, public.${BRANCHES}`);
    await app.close();
  });

  const get = (column: string) => app.inject({ method: "GET", url: `/app/api/dataviews/${dataviewId}/columns/${column}/reference`, headers: { authorization: `Bearer ${token}` } });

  it("names a view's column's row through the table column it is (DB26)", async () => {
    const res = await get("branch");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ schema: "public", table: BRANCHES, column: "id", displayField: "name" });
  });

  it("answers 404 for a column the viewer may not read, and null for one that points at nothing (DB40)", async () => {
    expect((await get("secret")).statusCode).toBe(404);
    const plain = await get("id");
    expect(plain.statusCode).toBe(200);
    expect(plain.json().data).toBeNull();
  });
});
