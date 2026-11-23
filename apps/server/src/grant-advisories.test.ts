import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

/**
 * A written grant's advice (meta.warnings, Security.md §6.5, §6.10) - the security lab's PERM-01 and API-2: a related
 * field read without the role's row filter on its table, and a foreign key a role may point at rows it can't read.
 */
describe("grant advice", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  const resources: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.grant_advice_reports, public.grant_advice_cases CASCADE`);
    await database.query(`CREATE TABLE public.grant_advice_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number text NOT NULL, reserved boolean NOT NULL DEFAULT false)`);
    await database.query(`CREATE TABLE public.grant_advice_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "case" uuid NOT NULL REFERENCES public.grant_advice_cases, body text NOT NULL)`);
    for (const name of ["grant_advice_cases", "grant_advice_reports"]) {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET','POST']) RETURNING id`,
        [`public.${name}`, name],
      );
      resources[name] = rows[0]!.id;
    }
    roleId = (await context.roles.create("grant-advice-test-role", { apiAccess: true })).id;
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [Object.values(resources)]);
    await database.query(`DROP TABLE IF EXISTS public.grant_advice_reports, public.grant_advice_cases CASCADE`);
    await app.close();
  });

  const grant = (resource: string, action: string, data: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/admin/api/roles/${roleId}/resources/${resources[resource]}/permissions/${action}`, headers: { authorization: `Bearer ${adminToken}` }, payload: { data } });
  const fields = (...names: string[]) => names.map((field) => ({ field, effect: "ALLOW" }));

  it("warns where a grant reaches rows the role's row filter on another table keeps from it - and only there", async () => {
    // No row filter on cases yet: nothing to say.
    expect((await grant("grant_advice_cases", "READ", { effect: "ALLOW", fields: fields("id", "number") })).json().meta).toBeUndefined();
    expect((await grant("grant_advice_reports", "READ", { effect: "ALLOW", fields: fields("id", "case", "case.number") })).json().meta).toBeUndefined();

    await grant("grant_advice_cases", "READ", { effect: "ALLOW", fields: fields("id", "number"), where: { reserved: { _eq: false } } });
    const read = (await grant("grant_advice_reports", "READ", { effect: "ALLOW", fields: fields("id", "case", "case.number") })).json();
    expect(read.meta.warnings).toEqual([expect.stringMatching(/^"case\.number" reads grant_advice_cases through case without this role's row filter/)]);

    const create = (await grant("grant_advice_reports", "CREATE", { effect: "ALLOW", fields: fields("case", "body") })).json();
    expect(create.meta.warnings).toEqual([expect.stringMatching(/^grant_advice_reports\.case may point at any grant_advice_cases row, while this role reads only some/)]);
    // A grant that names the column in its row filter (or a payload check) keeps it among them: nothing to say.
    const scoped = (await grant("grant_advice_reports", "CREATE", { effect: "ALLOW", fields: fields("case", "body"), where: { "case.reserved": { _eq: false } } })).json();
    expect(scoped.meta).toBeUndefined();
  });
});
