import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken as loginAdmin, setupTestApp } from "./test-support.js";

const P = "users-role-order";

/** A role's Members tab: every user, the role's holders first (?role_first=), or only those without it (?not_role=). */
describe("the user list by a role", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let role: string;
  const ids: Record<string, string> = {};

  const list = async (query: string) => {
    const response = await app.inject({ method: "GET", url: `/admin/api/users?${query}`, headers: { authorization: `Bearer ${adminToken}` } });
    return response;
  };

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}-%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    adminToken = await loginAdmin(context);
    role = (await context.roles.create(`${P}-crew`)).id;
    for (const name of ["delta", "alpha", "charlie", "bravo"]) {
      ids[name] = (await context.auth.users.create({ email: `${P}-${name}@example.com`, name: `${P} ${name}`, emailVerified: true })).id;
    }
    await context.roleAssignments.setRolesForUser(ids.delta!, [role]);
    await context.roleAssignments.setRolesForUser(ids.bravo!, [role]);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("lists the holders first, then the rest, each by name - paged without repeating anyone", async () => {
    const names = async (offset: number) =>
      ((await list(`q=${P}&role_first=${role}&limit=3&offset=${offset}`)).json().data as { name: string }[]).map((u) => u.name);
    expect([...(await names(0)), ...(await names(3))]).toEqual([`${P} bravo`, `${P} delta`, `${P} alpha`, `${P} charlie`]);
  });

  it("filters to those without the role", async () => {
    const response = await list(`q=${P}&not_role=${role}&limit=10`);
    expect((response.json().data as { id: string }[]).map((u) => u.id).sort()).toEqual([ids.alpha, ids.charlie].sort());
    expect(response.json().meta).toEqual({ total: 2 });
  });

  it("refuses a value that isn't a role id", async () => {
    expect((await list("role_first=x&limit=1")).statusCode).toBe(400);
  });
});
