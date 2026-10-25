import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { runRetention } from "./retention.js";
import { adminToken as loginAdmin, setupTestApp } from "./test-support.js";

const P = "access-governance";
const PASSWORD = "a-strong-enough-password";

/** Security.md §1.9-§1.11: incompatible roles, assignments that end, dormant accounts. */
describe("access governance", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let operator: string;
  let auditor: string;

  const call = (method: "GET" | "PUT" | "POST" | "PATCH", url: string, payload?: object, token = adminToken) => {
    const headers = { authorization: `Bearer ${token}` };
    return payload === undefined ? app.inject({ method, url, headers }) : app.inject({ method, url, headers, payload });
  };
  const user = async (name: string) =>
    (await context.auth.users.create({ email: `${P}-${name}@example.com`, name, passwordHash: await hashPassword(PASSWORD), emailVerified: true })).id;

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}-%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    adminToken = await loginAdmin(context);
    operator = (await context.roles.create(`${P}-operator`)).id;
    auditor = (await context.roles.create(`${P}-auditor`)).id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("never lets one user hold two incompatible roles - on any path - nor a pair someone already holds", async () => {
    const both = await user("both");
    await context.roleAssignments.setRolesForUser(both, [operator, auditor]);
    const refused = await call("PUT", `/admin/api/roles/${operator}/incompatible`, { data: { roleIds: [auditor] } });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.json().errors[0].message).toContain("hold both roles");

    await context.roleAssignments.setRolesForUser(both, [operator]);
    expect((await call("PUT", `/admin/api/roles/${operator}/incompatible`, { data: { roleIds: [auditor] } })).json().data).toEqual([auditor]);
    expect((await call("GET", `/admin/api/roles/${auditor}/incompatible`)).json().data).toEqual([operator]);

    const viaAdmin = await call("PUT", `/admin/api/users/${both}/roles`, { data: { roleIds: [operator, auditor] } });
    expect(viaAdmin.statusCode).toBeGreaterThanOrEqual(400);
    expect(viaAdmin.json().errors[0].message).toContain("can't be held together");
    const viaData = await call("POST", "/api/totalbase/table/users_roles", { data: { user: both, role: auditor } });
    expect(viaData.statusCode).toBeGreaterThanOrEqual(400);
    expect((await database.query(`SELECT 1 FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [both, auditor])).rows).toHaveLength(0);
  });

  it("ends an assignment at its expiry: it grants nothing at once, and the hourly job removes it", async () => {
    const temp = await user("temp");
    await context.roleAssignments.setRolesForUser(temp, [operator]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call("PUT", `/admin/api/users/${temp}/roles/${operator}/expiry`, { data: { expiresAt: tomorrow } })).statusCode).toBe(204);
    expect(await context.roleAssignments.listEffectiveRolesForUser(temp)).toEqual([operator]);
    // A role set kept keeps its expiry.
    await call("PUT", `/admin/api/users/${temp}/roles`, { data: { roleIds: [operator] } });
    expect((await database.query<{ e: Date | null }>(`SELECT expires_at AS e FROM totalbase.users_roles WHERE "user" = $1`, [temp])).rows[0]!.e).not.toBeNull();

    await database.query(`UPDATE totalbase.users_roles SET expires_at = now() - interval '1 minute' WHERE "user" = $1`, [temp]);
    expect(await context.roleAssignments.listEffectiveRolesForUser(temp)).toEqual([]);
    const result = await runRetention(context);
    expect(result.expiredAssignments).toBeGreaterThanOrEqual(1);
    expect(await context.roleAssignments.listRolesForUser(temp)).toEqual([]);

    // A reserved role never lapses; an unknown assignment is 404.
    const administrators = await context.roles.getAdministratorsRoleId();
    await context.roleAssignments.assignRoleToUser(temp, administrators);
    expect((await call("PUT", `/admin/api/users/${temp}/roles/${administrators}/expiry`, { data: { expiresAt: tomorrow } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await call("PUT", `/admin/api/users/${temp}/roles/${auditor}/expiry`, { data: { expiresAt: tomorrow } })).statusCode).toBe(404);
    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1`, [temp]);
  });

  it("deactivates the accounts unused for auth.dormant_account_days - never the owner, never a recent one", async () => {
    const idle = await user("idle");
    const busy = await user("busy");
    await database.query(`UPDATE totalbase.users SET created_at = now() - interval '200 days', last_login_at = now() - interval '120 days' WHERE id = $1`, [idle]);
    await database.query(`UPDATE totalbase.users SET created_at = now() - interval '200 days', last_login_at = now() - interval '1 day' WHERE id = $1`, [busy]);
    await context.settings.set("auth.dormant_account_days", 90);
    try {
      const result = await runRetention(context);
      expect(result.dormantAccounts).toBeGreaterThanOrEqual(1);
      const active = async (id: string) => (await database.query<{ active: boolean }>(`SELECT active FROM totalbase.users WHERE id = $1`, [id])).rows[0]!.active;
      expect(await active(idle)).toBe(false);
      expect(await active(busy)).toBe(true);
      const { rows } = await database.query<{ active: boolean }>(`SELECT active FROM totalbase.users WHERE owner`);
      expect(rows[0]?.active).toBe(true);
    } finally {
      await context.settings.reset("auth.dormant_account_days");
    }
  });

  it("marks a role for periodic review - an administrator's flag", async () => {
    const res = await call("PATCH", `/api/totalbase/table/roles/${auditor}`, { data: { review_required: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await context.roles.findById(auditor))?.reviewRequired).toBe(true);
  });
});
