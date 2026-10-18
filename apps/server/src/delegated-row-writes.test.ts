import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { cleanupTracked, setupTestApp, track, uniqueSuffix } from "./test-support.js";

// Short: a slug is at most 32 characters.
const P = `rw-${uniqueSuffix()}`;
const PASSWORD = "a-strong-enough-password";
const MAILING = { subject: "Hi", message: "Hello" };

/**
 * Templates and folders are plain Data API rows for everyone
 * (Specification_Security.md §10.3 step 4) - the dedicated
 * /app/api/templates and /app/api/folders writes are gone. What those
 * routes guaranteed still holds: the grant, its row filter before and
 * after, field grants, the name/slug rules (PostgreSQL CHECKs) and the
 * folder's creator (a trigger).
 */
describe("Templates and folders as Data API rows", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let editorToken: string;
  let editorId: string;
  let noneToken: string;

  const templates = "/api/totalbase/table/templates";
  const folders = "/api/totalbase/table/folders";
  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });
  const fields = (...names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));

  async function login(email: string, roleId: string): Promise<{ token: string; id: string }> {
    const user = await context.auth.users.create({ email, name: "x", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    track("users", user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return { token: (await context.auth.login({ email, password: PASSWORD })).token, id: user.id };
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const resource = async (name: string) =>
      (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = $1`, [name])).rows[0]!.id;
    // Fixed exposure - applied by a reconcile, whatever earlier suites left.
    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET,POST,PATCH,DELETE}' WHERE "schema" = 'totalbase' AND name IN ('templates', 'folders')`);
    const templatesId = await resource("templates");
    const foldersId = await resource("folders");
    const editorRole = track("roles", (await context.roles.create(`${P}-editors`, { appAccess: true })).id);
    const noneRole = track("roles", (await context.roles.create(`${P}-none`, { appAccess: true })).id);
    // Editors write only MAILING templates (never the default Cc), and only their own folders' names.
    const mailingOnly = { kind: { _eq: "MAILING" } };
    const writable = fields("name", "description", "slug", "kind", "content");
    await context.permissions.set(editorRole, templatesId, "CREATE", { effect: "ALLOW", where: mailingOnly, fields: writable });
    await context.permissions.set(editorRole, templatesId, "UPDATE", { effect: "ALLOW", where: mailingOnly, fields: writable });
    await context.permissions.set(editorRole, templatesId, "DELETE", { effect: "ALLOW", where: mailingOnly });
    const own = { created_by: { _eq: "$USER.id" } };
    await context.permissions.set(editorRole, foldersId, "CREATE", { effect: "ALLOW", where: own, fields: fields("name") });
    await context.permissions.set(editorRole, foldersId, "UPDATE", { effect: "ALLOW", where: own, fields: fields("name") });
    await context.permissions.set(editorRole, foldersId, "DELETE", { effect: "ALLOW", where: own });
    ({ token: editorToken, id: editorId } = await login(`${P}-editor@example.com`, editorRole));
    ({ token: noneToken } = await login(`${P}-none@example.com`, noneRole));
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await app.close();
  });

  it("refuses a caller with no grant", async () => {
    expect((await call("POST", templates, noneToken, { data: { name: "Nope", slug: `${P}-nope`, kind: "MAILING", content: MAILING } })).statusCode).toBe(403);
    expect((await call("POST", folders, noneToken, { data: { name: `${P}-nope` } })).statusCode).toBe(403);
  });

  it("creates a template within the grant, with the name and slug rules", async () => {
    const res = await call("POST", templates, editorToken, { data: { name: "Welcome", slug: `${P}-welcome`, kind: "MAILING", content: MAILING } });
    expect(res.statusCode, res.body).toBe(201);
    track("templates", res.json().data.id);
    const badName = await call("POST", templates, editorToken, { data: { name: "bad/name", slug: `${P}-bad`, kind: "MAILING", content: MAILING } });
    expect([badName.statusCode, badName.json().errors[0].code]).toEqual([422, "CHECK_VIOLATION"]);
    const badSlug = await call("POST", templates, editorToken, { data: { name: "Fine", slug: "Not A Slug", kind: "MAILING", content: MAILING } });
    expect(badSlug.statusCode).toBe(422);
  });

  it("refuses a template outside the grant's filter, and a column without a field grant - writing nothing", async () => {
    const pdf = await call("POST", templates, editorToken, { data: { name: "Invoice", slug: `${P}-invoice`, kind: "PDF", content: { schemas: [] } } });
    expect(pdf.statusCode).toBe(403);
    const cc = await call("POST", templates, editorToken, { data: { name: "Cc", slug: `${P}-cc`, kind: "MAILING", content: MAILING, default_cc: ["a@example.com"] } });
    expect(cc.statusCode).toBe(403);
    const { rows } = await database.query(`SELECT 1 FROM totalbase.templates WHERE slug = ANY($1)`, [[`${P}-invoice`, `${P}-cc`]]);
    expect(rows).toHaveLength(0);
  });

  it("authorizes a template update on the row before and after it, and a delete on the row itself", async () => {
    const pdfId = track("templates", (await context.templatesAdmin.create({ name: "Report", slug: `${P}-report`, kind: "PDF", content: { schemas: [] } })).id);
    expect((await call("PATCH", `${templates}/${pdfId}`, editorToken, { data: { name: "Renamed" } })).statusCode).toBe(404);
    expect((await call("DELETE", `${templates}/${pdfId}`, editorToken)).statusCode).toBe(404);

    const own = (await call("POST", templates, editorToken, { data: { name: "Reminder", slug: `${P}-reminder`, kind: "MAILING", content: MAILING } })).json().data;
    track("templates", own.id);
    // NEW outside the filter: refused and rolled back.
    expect((await call("PATCH", `${templates}/${own.id}`, editorToken, { data: { kind: "PDF", content: { schemas: [] } } })).statusCode).toBe(403);
    const renamed = await call("PATCH", `${templates}/${own.id}`, editorToken, { data: { name: "Reminder 2" } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    // The response projects only what the caller may read (no READ grant here).
    expect((await database.query<{ name: string }>(`SELECT name FROM totalbase.templates WHERE id = $1`, [own.id])).rows[0]!.name).toBe("Reminder 2");
    expect((await call("DELETE", `${templates}/${own.id}`, editorToken)).statusCode).toBe(200);
  });

  it("creates a folder as the caller (a trigger records the creator) and renames or deletes only their own", async () => {
    const res = await call("POST", folders, editorToken, { data: { name: `${P}-mine` } });
    expect(res.statusCode, res.body).toBe(201);
    track("folders", res.json().data.id);
    const { rows } = await database.query<{ created_by: string }>(`SELECT created_by FROM totalbase.folders WHERE id = $1`, [res.json().data.id]);
    expect(rows[0]!.created_by).toBe(editorId);
    expect((await call("POST", folders, editorToken, { data: { name: "bad/name" } })).statusCode).toBe(422);

    const other = await context.foldersAdmin.create({ parent: null, name: `${P}-theirs` });
    track("folders", other.id);
    expect((await call("PATCH", `${folders}/${other.id}`, editorToken, { data: { name: `${P}-taken` } })).statusCode).toBe(404);
    expect((await call("DELETE", `${folders}/${other.id}`, editorToken)).statusCode).toBe(404);

    const renamed = await call("PATCH", `${folders}/${res.json().data.id}`, editorToken, { data: { name: `${P}-renamed` } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await call("DELETE", `${folders}/${res.json().data.id}`, editorToken)).statusCode).toBe(200);
  });
});
