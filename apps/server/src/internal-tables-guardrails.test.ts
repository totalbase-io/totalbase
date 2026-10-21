import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp, uniqueSuffix } from "./test-support.js";

const P = `internal-guard-test-${uniqueSuffix()}`;
const PASSWORD = "a-strong-enough-password";

/**
 * Security.md §10.3 step 1 - regressions for two gaps
 * found reviewing the Admin API:
 * - rules that lived only in the services (role name and icon, template
 *   name and slug, folder name, user email and name) are PostgreSQL CHECKs,
 *   so they hold for every writer, the Data API included;
 * - tables that grant access or decide how the system behaves are written
 *   by administrators only, whatever a role's grant on them says.
 */
describe("Internal tables: rules in PostgreSQL, administrator-written tables", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let delegateToken: string;
  let delegateId: string;
  let delegateRole: string;
  const resources: Record<string, string> = {};
  const previousExposure = new Map<string, string[]>();

  const ADMIN_WRITTEN = [
    "roles_capabilities",
    "identities",
    "providers",
    "settings",
    "resources",
    "secrets",
    "audits_exclusions",
    "migrations",
    "outbox",
    "idempotency_keys",
    "executions",
  ];

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${delegateToken}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  const rejects = (sql: string, params: unknown[] = []) =>
    expect(database.query(sql, params)).rejects.toMatchObject({ code: "CHECK_VIOLATION" });

  async function cleanup(): Promise<void> {
    // The guardrails refuse these writes; the exact rows they would have made, in case one got through.
    await database.query(`DELETE FROM totalbase.identities WHERE provider_subject = $1`, [`${P}-subject`]);
    await database.query(`DELETE FROM totalbase.settings WHERE key = $1`, [`${P}.key`]);
    if (delegateId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [delegateId]);
    if (delegateRole) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [delegateRole]);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const { rows } = await database.query<{ id: string; name: string; exposed_methods: string[] }>(
      `SELECT id, name, exposed_methods FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = ANY($1)`,
      [[...ADMIN_WRITTEN, "roles"]],
    );
    for (const row of rows) {
      resources[row.name] = row.id;
      previousExposure.set(row.id, row.exposed_methods);
      await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET,POST,PATCH,DELETE}' WHERE id = $1`, [row.id]);
    }
    delegateRole = (await context.roles.create(`${P}-delegates`, { appAccess: true })).id;
    const user = await context.auth.users.create({ email: `${P}-delegate@example.com`, name: "Delegate", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    delegateId = user.id;
    await context.roleAssignments.assignRoleToUser(user.id, delegateRole);
    delegateToken = (await context.auth.login({ email: `${P}-delegate@example.com`, password: PASSWORD })).token;
  });

  afterAll(async () => {
    for (const [id, methods] of previousExposure) await database.query(`UPDATE totalbase.resources SET exposed_methods = $2 WHERE id = $1`, [id, methods]);
    await cleanup();
    await app.close();
  });

  it("keeps TotalBase's own tables at their fixed exposure - not editable, repaired on reconcile", async () => {
    const env = loadServerEnv();
    const admin = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    const asAdmin = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });
    const users = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`)).rows[0]!.id;

    const narrowed = await asAdmin("PATCH", `/admin/api/resources/${users}`, { data: { exposedMethods: [] } });
    expect([narrowed.statusCode, narrowed.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);

    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{}' WHERE id = $1`, [users]);
    expect((await asAdmin("POST", "/admin/api/catalog/refresh")).statusCode).toBeLessThan(300);
    const { rows } = await database.query<{ exposed_methods: string[] }>(`SELECT exposed_methods FROM totalbase.resources WHERE id = $1`, [users]);
    expect(rows[0]!.exposed_methods).toEqual(["GET", "POST", "PATCH", "DELETE"]);
  });

  it("refuses, at the database, what the services used to refuse alone", async () => {
    await rejects(`INSERT INTO totalbase.roles (name) VALUES ($1)`, ["x".repeat(65)]);
    await rejects(`INSERT INTO totalbase.roles (name) VALUES ($1)`, [` ${P}-padded`]);
    await rejects(`INSERT INTO totalbase.roles (name, icon) VALUES ($1, $2)`, [`${P}-icon`, "javascript:alert(1)"]);
    await rejects(`INSERT INTO totalbase.templates (name, slug, kind, content) VALUES ($1, $2, 'PDF', '{}')`, ["a/b", `${P}-t1`]);
    await rejects(`INSERT INTO totalbase.templates (name, slug, kind, content) VALUES ($1, $2, 'PDF', '{}')`, ["Bidi" + String.fromCharCode(0x202e), `${P}-t2`]);
    await rejects(`INSERT INTO totalbase.templates (name, slug, kind, content) VALUES ($1, $2, 'PDF', '{}')`, ["Fine", "Not A Slug"]);
    await rejects(`INSERT INTO totalbase.folders (name) VALUES ($1)`, ["a<b"]);
    await rejects(`INSERT INTO totalbase.users (email) VALUES ($1)`, [`${P}-not-an-email`]);
    await rejects(`INSERT INTO totalbase.users (email, name) VALUES ($1, $2)`, [`${P}-long@example.com`, "n".repeat(201)]);
    // Unicode names still pass, whatever the database's locale.
    const ok = await database.query<{ id: string }>(`INSERT INTO totalbase.folders (name) VALUES ($1) RETURNING id`, [`Año Ünico 日本`]);
    await database.query(`DELETE FROM totalbase.folders WHERE id = $1`, [ok.rows[0]!.id]);
  });

  it("applies them to a delegated user's Data API writes too", async () => {
    await context.permissions.set(delegateRole, resources.roles!, "CREATE", {
      effect: "ALLOW",
      fields: [{ field: "name", effect: "ALLOW" }, { field: "icon", effect: "ALLOW" }],
    });
    const long = await call("POST", "/api/totalbase/table/roles", { data: { name: "x".repeat(65) } });
    expect([long.statusCode, long.json().errors[0].code]).toEqual([422, "CHECK_VIOLATION"]);
    const icon = await call("POST", "/api/totalbase/table/roles", { data: { name: `${P}-icon`, icon: "<svg onload=x>" } });
    expect([icon.statusCode, icon.json().errors[0].code]).toEqual([422, "CHECK_VIOLATION"]);
    const { rows } = await database.query(`SELECT 1 FROM totalbase.roles WHERE created_by = $1`, [delegateId]);
    expect(rows).toHaveLength(0);
  });

  it("never lets a non-administrator write a table that grants access or runs the system, whatever the grant", async () => {
    // Defense in depth: most of these aren't exposed at all (fixed exposure);
    // exposed by hand, the guardrail still refuses.
    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET,POST,PATCH,DELETE}' WHERE id = ANY($1)`, [Object.values(resources)]);
    for (const table of ADMIN_WRITTEN) {
      const id = resources[table];
      if (!id) continue; // not registered as a resource on this instance
      for (const action of ["CREATE", "UPDATE", "DELETE"] as const) {
        await context.permissions.set(delegateRole, id, action, { effect: "ALLOW", fields: [{ field: "*", effect: "ALLOW" }] });
      }
    }
    // Linking a provider account to someone else is a sign-in as them.
    const identity = await call("POST", "/api/totalbase/table/identities", {
      data: { user: delegateId, provider: "GOOGLE", provider_subject: `${P}-subject` },
    });
    expect(identity.json().errors[0].message, identity.body).toContain("written by administrators only");
    const setting = await call("POST", "/api/totalbase/table/settings", { data: { key: `${P}.key`, value: true } });
    expect(setting.json().errors[0].message, setting.body).toContain("written by administrators only");
    const exposure = await call("PATCH", `/api/totalbase/table/resources/${resources.roles}`, { data: { exposed_methods: [] } });
    expect(exposure.json().errors[0].message, exposure.body).toContain("written by administrators only");
    const capability = await call("POST", "/api/totalbase/table/roles_capabilities", { data: { role: delegateRole, capability: "TRANSACTIONS", effect: "ALLOW" } });
    expect(capability.json().errors[0].message, capability.body).toContain("written by administrators only");

    const { rows } = await database.query(
      `SELECT 1 FROM totalbase.identities WHERE provider_subject = $1
       UNION ALL SELECT 1 FROM totalbase.settings WHERE key = $2
       UNION ALL SELECT 1 FROM totalbase.roles_capabilities WHERE role = $3`,
      [`${P}-subject`, `${P}.key`, delegateRole],
    );
    expect(rows).toHaveLength(0);
  });
});
