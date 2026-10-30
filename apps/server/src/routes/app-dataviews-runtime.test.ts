import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { cleanupTracked, setupTestApp, track, uniqueSuffix } from "../test-support.js";

// Short: a slug is at most 32 characters.
const P = `dvrt-${uniqueSuffix()}`;
const TABLE = "app_dv_runtime_test_items";
const PASSWORD = "a-strong-enough-password";

/**
 * What a published DataView needs at runtime, served to every portal user
 * (app-dataviews-runtime.ts): only for a DataView the caller may open; a
 * catalog narrowed to the columns they may read; saved views and prefs
 * owner-scoped; the bulk audit event only on a readable resource.
 */
describe("App DataView runtime (/app/api/dataviews/:slug/...)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let viewerToken: string;
  let otherToken: string;
  let resourceId: string;
  let dataviewId: string;
  let viewerRoleId: string;

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });

  /** Every row this file creates is tracked and deleted by id (DataViews first - they reference the rest). */
  async function cleanup(): Promise<void> {
    await cleanupTracked(database);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
  }
  const createView: AppContext["dataviewsAdmin"]["create"] = async (input) => {
    const view = await context.dataviewsAdmin.create(input);
    track("dataviews", view.id);
    return view;
  };

  async function login(email: string, roleId: string): Promise<string> {
    const user = await context.auth.users.create({ email, name: "x", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    track("users", user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return (await context.auth.login({ email, password: PASSWORD })).token;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, secret text, owner uuid)`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.${TABLE}')::oid, 'public', '${TABLE}', 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
    )).rows[0]!.id;
    track("resources", resourceId);

    const viewerRole = track("roles", (await context.roles.create(`${P}-viewer`, { appAccess: true })).id);
    const otherRole = track("roles", (await context.roles.create(`${P}-other`, { appAccess: true })).id);
    // The viewer reads id and name, never `secret`.
    await context.permissions.set(viewerRole, resourceId, "READ", {
      effect: "ALLOW",
      fields: [{ field: "id", effect: "ALLOW" }, { field: "name", effect: "ALLOW" }],
    });
    viewerRoleId = viewerRole;
    viewerToken = await login(`${P}-viewer@example.com`, viewerRole);
    otherToken = await login(`${P}-other@example.com`, otherRole);

    dataviewId = (await createView({ name: `Runtime ${P}`, slug: `${P}-dv`, sourceResourceId: resourceId, viewType: "TABLE" })).id;
    await context.dataviewsAdmin.setRoles(dataviewId, [viewerRole]);
    await context.dataviewsAdmin.publish(dataviewId, null);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("answers every runtime route like a missing DataView to someone who may not open it", async () => {
    for (const [method, url] of [
      ["GET", `/app/api/dataviews/${dataviewId}/user-prefs`],
      ["GET", `/app/api/dataviews/${dataviewId}/saved-views`],
      ["GET", `/app/api/dataviews/${dataviewId}/catalog`],
    ] as const) {
      const res = await call(method, url, otherToken);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().errors[0].code).toBe("RESOURCE_NOT_FOUND");
    }
    expect((await call("PUT", `/app/api/dataviews/${dataviewId}/user-prefs`, otherToken, { data: { config: {} } })).statusCode).toBe(404);
  });

  it("?draft=true serves the draft to an administrator - the device preview - and nothing to anyone else", async () => {
    const env = loadServerEnv();
    const adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    // A draft change the published version doesn't have: a column's width.
    const name = (await context.dataviewsAdmin.listFields(dataviewId)).find((f) => f.columnName === "name")!;
    await context.dataviewsAdmin.updateField(dataviewId, name.id, { gridW: 5 });
    try {
      const draftFields = await call("GET", `/app/api/dataviews/${P}-dv/fields?draft=true`, adminToken);
      expect(draftFields.statusCode, draftFields.body).toBe(200);
      expect(draftFields.json().data.find((f: { columnName: string }) => f.columnName === "name").gridW).toBe(5);
      const published = await call("GET", `/app/api/dataviews/${P}-dv/fields`, adminToken);
      expect(published.json().data.find((f: { columnName: string }) => f.columnName === "name").gridW).not.toBe(5);
      expect((await call("GET", `/app/api/dataviews/${P}-dv?draft=true`, adminToken)).statusCode).toBe(200);

      for (const url of [`/app/api/dataviews/${P}-dv?draft=true`, `/app/api/dataviews/${P}-dv/fields?draft=true`]) {
        const res = await call("GET", url, viewerToken);
        expect([res.statusCode, res.json().errors?.[0]?.code], url).toEqual([404, "RESOURCE_NOT_FOUND"]);
      }
    } finally {
      await context.dataviewsAdmin.updateField(dataviewId, name.id, { gridW: 12 });
    }
  });

  it("serves a published column renamed since under its name now, and leaves one dropped since out - the Data API would refuse every row", async () => {
    const env = loadServerEnv();
    const adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await database.query(`ALTER TABLE public.${TABLE} ADD COLUMN gone text, ADD COLUMN moved text`);
    try {
      await context.dataviewsAdmin.syncFields(dataviewId);
      await context.dataviewsAdmin.publish(dataviewId, null);
      await database.query(`ALTER TABLE public.${TABLE} DROP COLUMN gone`);
      await database.query(`ALTER TABLE public.${TABLE} RENAME COLUMN moved TO kept`);
      const res = await call("GET", `/app/api/dataviews/${dataviewId}/fields`, adminToken);
      expect(res.statusCode, res.body).toBe(200);
      const columns = res.json().data.filter((f: { kind: string }) => f.kind === "COLUMN").map((f: { columnName: string }) => f.columnName);
      expect(columns).toContain("kept");
      expect(columns).not.toContain("gone");
      expect(columns).not.toContain("moved");
    } finally {
      await database.query(`ALTER TABLE public.${TABLE} DROP COLUMN IF EXISTS gone, DROP COLUMN IF EXISTS kept`);
      for (const field of (await context.dataviewsAdmin.listFields(dataviewId)).filter((f) => f.orphaned)) await context.dataviewsAdmin.deleteField(dataviewId, field.id);
      await context.dataviewsAdmin.publish(dataviewId, null);
    }
  });

  it("sends the instance's toolbar default with the DataView - an App user can't read the settings", async () => {
    const overridden = await context.settings.isOverridden("dataviews.toolbar_mode");
    const before = await context.settings.get("dataviews.toolbar_mode");
    try {
      expect((await call("GET", `/app/api/dataviews/${P}-dv`, viewerToken)).json().data.instanceToolbarMode).toBe(before === "auto" ? null : before);
      await context.settings.set("dataviews.toolbar_mode", "compact");
      expect((await call("GET", `/app/api/dataviews/${P}-dv`, viewerToken)).json().data.instanceToolbarMode).toBe("compact");
      await context.settings.set("dataviews.toolbar_mode", "auto");
      expect((await call("GET", `/app/api/dataviews/${P}-dv`, viewerToken)).json().data.instanceToolbarMode).toBeNull();
    } finally {
      if (overridden) await context.settings.set("dataviews.toolbar_mode", before);
      else await context.settings.reset("dataviews.toolbar_mode");
    }
  });

  it("sends the instance's page width defaults with the DataView", async () => {
    const overridden = await context.settings.isOverridden("dataviews.custom_content_width");
    const before = await context.settings.get("dataviews.custom_content_width");
    try {
      await context.settings.set("dataviews.custom_content_width", "narrow");
      expect((await call("GET", `/app/api/dataviews/${P}-dv`, viewerToken)).json().data.instancePageLayout).toMatchObject({ customWidth: "narrow" });
    } finally {
      if (overridden) await context.settings.set("dataviews.custom_content_width", before);
      else await context.settings.reset("dataviews.custom_content_width");
    }
  });

  it("narrows the catalog to the columns the viewer may read", async () => {
    const res = await call("GET", `/app/api/dataviews/${dataviewId}/catalog`, viewerToken);
    expect(res.statusCode, res.body).toBe(200);
    const names = res.json().data.columns.map((c: { name: string }) => c.name);
    expect(names.sort()).toEqual(["id", "name"]);
    expect(res.json().data.checkConstraints).toEqual([]);
  });

  it("gives a page's record table: the columns the viewer reads, and those they may write on create and on update", async () => {
    // A CUSTOM page over the table: its record. The viewer may create with a name, and update nothing.
    await context.permissions.set(viewerRoleId, resourceId, "CREATE", { effect: "ALLOW", fields: [{ field: "name", effect: "ALLOW" }] });
    const page = await createView({ name: `Record page ${P}`, slug: `${P}-record`, sourceResourceId: resourceId, viewType: "CUSTOM" });
    await context.dataviewsAdmin.setRoles(page.id, [viewerRoleId]);
    await context.dataviewsAdmin.publish(page.id, null);

    const res = await call("GET", `/app/api/dataviews/${page.id}/record`, viewerToken);
    expect(res.statusCode, res.body).toBe(200);
    const { catalog, writable } = res.json().data;
    expect(catalog.columns.map((c: { name: string }) => c.name).sort()).toEqual(["id", "name"]);
    expect(catalog.primaryKey).toEqual(["id"]);
    expect(writable).toEqual({ create: ["name"], update: [] });
    expect((await call("GET", `/app/api/dataviews/${page.id}/record`, otherToken)).statusCode).toBe(404);
    // A page without a record table has none to give.
    const blank = await createView({ name: `Blank page ${P}`, slug: `${P}-blank`, viewType: "CUSTOM" });
    await context.dataviewsAdmin.setRoles(blank.id, [viewerRoleId]);
    await context.dataviewsAdmin.publish(blank.id, null);
    expect((await call("GET", `/app/api/dataviews/${blank.id}/record`, viewerToken)).statusCode).toBe(404);
  });

  it("never gives a Password column as readable: write-only in a record's catalog where the viewer may write it, out of the filter catalog", async () => {
    await database.query(
      `INSERT INTO totalbase.resources_columns (resource, attnum, name, config)
       SELECT $1, attnum, attname, '{"input":"password"}' FROM pg_attribute WHERE attrelid = $2::regclass AND attname = 'secret'
       ON CONFLICT (resource, attnum) DO UPDATE SET config = excluded.config`,
      [resourceId, `public.${TABLE}`],
    );
    try {
      const page = await createView({ name: `Password page ${P}`, slug: `${P}-password`, sourceResourceId: resourceId, viewType: "CUSTOM" });
      await context.dataviewsAdmin.setRoles(page.id, [viewerRoleId]);
      await context.dataviewsAdmin.publish(page.id, null);
      const record = async () => (await call("GET", `/app/api/dataviews/${page.id}/record`, viewerToken)).json().data;
      // Even with a READ grant on it, it is never readable - and not in the record while the viewer may not write it.
      await context.permissions.set(viewerRoleId, resourceId, "READ", {
        effect: "ALLOW",
        fields: ["id", "name", "secret"].map((field) => ({ field, effect: "ALLOW" as const })),
      });
      expect((await call("GET", `/app/api/dataviews/${page.id}/catalog`, viewerToken)).json().data.columns.map((c: { name: string }) => c.name).sort()).toEqual(["id", "name"]);
      expect((await record()).writeOnly).toEqual([]);
      // Allowed to set it: in the catalog, write-only.
      await context.permissions.set(viewerRoleId, resourceId, "CREATE", { effect: "ALLOW", fields: ["name", "secret"].map((field) => ({ field, effect: "ALLOW" as const })) });
      const writable = await record();
      expect(writable.catalog.columns.map((c: { name: string }) => c.name).sort()).toEqual(["id", "name", "secret"]);
      expect(writable.writeOnly).toEqual(["secret"]);
      expect(writable.writable.create.sort()).toEqual(["name", "secret"]);
    } finally {
      await database.query(`DELETE FROM totalbase.resources_columns WHERE resource = $1 AND name = 'secret'`, [resourceId]);
      await context.permissions.set(viewerRoleId, resourceId, "CREATE", { effect: "ALLOW", fields: [{ field: "name", effect: "ALLOW" }] });
      await context.permissions.set(viewerRoleId, resourceId, "READ", {
        effect: "ALLOW",
        fields: [{ field: "id", effect: "ALLOW" }, { field: "name", effect: "ALLOW" }],
      });
    }
  });

  it("gives the patterns and bounds of the CHECKs on the columns the viewer may write - never the CHECKs", async () => {
    await context.permissions.set(viewerRoleId, resourceId, "CREATE", { effect: "ALLOW", fields: [{ field: "name", effect: "ALLOW" }] });
    await database.query(`ALTER TABLE public.${TABLE} ADD CONSTRAINT ${TABLE}_name_code CHECK (name ~ '^[A-Z]{3}[[:digit:]]+$')`);
    await database.query(`COMMENT ON CONSTRAINT ${TABLE}_name_code ON public.${TABLE} IS 'Three capitals, then digits.'`);
    await database.query(`ALTER TABLE public.${TABLE} ADD CONSTRAINT ${TABLE}_secret_code CHECK (secret ~ '^s')`);
    await database.query(`ALTER TABLE public.${TABLE} ADD CONSTRAINT ${TABLE}_name_length CHECK (length(name) <= 12)`);
    await database.query(`ALTER TABLE public.${TABLE} ADD CONSTRAINT ${TABLE}_secret_length CHECK (length(secret) >= 4)`);
    await database.query(`ALTER TABLE public.${TABLE} ADD CONSTRAINT ${TABLE}_name_list CHECK (name IN ('ABC1', 'XYZ2'))`);
    try {
      const page = await createView({ name: `Patterns page ${P}`, slug: `${P}-patterns`, sourceResourceId: resourceId, viewType: "CUSTOM" });
      await context.dataviewsAdmin.setRoles(page.id, [viewerRoleId]);
      await context.dataviewsAdmin.publish(page.id, null);

      const res = await call("GET", `/app/api/dataviews/${page.id}/record`, viewerToken);
      expect(res.statusCode, res.body).toBe(200);
      const { catalog, patterns, bounds, values } = res.json().data;
      // `secret` isn't the viewer's to write: neither its pattern, its bound nor any CHECK reaches them.
      expect(patterns).toEqual({ name: [{ source: "^[A-Z]{3}[0-9]+$", flags: "s", message: "Three capitals, then digits." }] });
      expect(bounds).toEqual({ name: [{ kind: "length", op: "<=", value: 12, message: null }] });
      expect(catalog.checkConstraints).toEqual([]);
      // A CHECK list's values - a select's options (B52) - but not the list itself.
      expect(values).toEqual({ name: ["ABC1", "XYZ2"] });
    } finally {
      await database.query(`ALTER TABLE public.${TABLE} DROP CONSTRAINT ${TABLE}_name_list, DROP CONSTRAINT ${TABLE}_name_code, DROP CONSTRAINT ${TABLE}_secret_code, DROP CONSTRAINT ${TABLE}_name_length, DROP CONSTRAINT ${TABLE}_secret_length`);
    }
  });

  it("refuses a view as a page's record table - a record is written", async () => {
    const view = `${TABLE}_view`;
    await database.query(`CREATE VIEW public.${view} AS SELECT id, name FROM public.${TABLE}`);
    try {
      const viewResource = (await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES (to_regclass('public.${view}')::oid, 'public', '${view}', 'VIEW', 'ACTIVE', ARRAY['GET']) RETURNING id`,
      )).rows[0]!.id;
      await expect(createView({ name: `View page ${P}`, slug: `${P}-view`, sourceResourceId: viewResource, viewType: "CUSTOM" }))
        .rejects.toMatchObject({ code: "DATAVIEW_SOURCE_TYPE_INVALID" });
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE name = '${view}'`);
      await database.query(`DROP VIEW public.${view}`);
    }
  });

  it("keeps a viewer's prefs and saved views their own", async () => {
    const put = await call("PUT", `/app/api/dataviews/${dataviewId}/user-prefs`, viewerToken, { data: { config: { sort: "name" } } });
    expect(put.statusCode, put.body).toBe(200);
    expect((await call("GET", `/app/api/dataviews/${dataviewId}/user-prefs`, viewerToken)).json().data.config).toEqual({ sort: "name" });

    const created = await call("POST", `/app/api/dataviews/${dataviewId}/saved-views`, viewerToken, { data: { name: "Mine", config: { sort: "-name" } } });
    expect(created.statusCode, created.body).toBe(201);
    const views = (await call("GET", `/app/api/dataviews/${dataviewId}/saved-views`, viewerToken)).json().data;
    expect(views.map((v: { name: string }) => v.name)).toEqual(["Mine"]);
    const viewId = created.json().data.id as string;
    expect((await call("GET", `/app/api/dataviews/${dataviewId}/saved-views/${viewId}/link`, viewerToken)).json().data.id).toBe(viewId);
    expect((await call("GET", `/app/api/dataviews/${dataviewId}/saved-views/${viewId}/link`, otherToken)).statusCode).toBe(404);
    expect((await call("DELETE", `/app/api/dataviews/${dataviewId}/saved-views/${viewId}`, viewerToken)).statusCode).toBe(204);
    // Gone: its link is a 404, not an empty 200.
    const stale = await call("GET", `/app/api/dataviews/${dataviewId}/saved-views/${viewId}/link`, viewerToken);
    expect(stale.statusCode).toBe(404);
    expect(stale.json().errors[0].code).toBe("DATAVIEW_STATE_NOT_FOUND");
  });

  it("shares a saved view with the sharer's own roles and the people holding one - read-only for them (DataViews.md §5.9)", async () => {
    const colleagueToken = await login(`${P}-colleague@example.com`, viewerRoleId);
    const otherRoleId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE name = $1`, [`${P}-other`])).rows[0]!.id;
    const otherUserId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [`${P}-other@example.com`])).rows[0]!.id;
    const colleagueId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [`${P}-colleague@example.com`])).rows[0]!.id;
    const base = `/app/api/dataviews/${dataviewId}/saved-views`;
    const created = await call("POST", base, viewerToken, { data: { name: "Orán", config: { layout: "CARDS", density: "compact" } } });
    expect(created.statusCode, created.body).toBe(201);
    const viewId = created.json().data.id as string;
    try {
      // Whom it may go to: their own role and its people - never another role or someone outside it.
      const candidates = (await call("GET", `${base}/share-candidates`, viewerToken)).json().data as { roles: { id: string }[], users: { id: string }[] };
      expect(candidates.roles.map(r => r.id)).toEqual([viewerRoleId]);
      expect(candidates.users.map(u => u.id)).toContain(colleagueId);
      expect(candidates.users.map(u => u.id)).not.toContain(otherUserId);
      expect((await call("POST", `${base}/${viewId}/shares`, viewerToken, { data: { roleId: otherRoleId } })).statusCode).toBe(403);
      expect((await call("POST", `${base}/${viewId}/shares`, viewerToken, { data: { userId: otherUserId } })).statusCode).toBe(403);

      const toRole = await call("POST", `${base}/${viewId}/shares`, viewerToken, { data: { roleId: viewerRoleId } });
      expect(toRole.statusCode, toRole.body).toBe(201);
      expect(toRole.json().data).toMatchObject({ kind: "ROLE", id: viewerRoleId, name: `${P}-viewer` });
      expect((await call("POST", `${base}/${viewId}/shares`, viewerToken, { data: { userId: colleagueId } })).statusCode).toBe(201);
      expect((await call("POST", `${base}/${viewId}/shares`, viewerToken, { data: { roleId: viewerRoleId, userId: colleagueId } })).statusCode).toBe(400);

      // A member of the role sees it, with who shared it, and can't change it.
      const theirs = (await call("GET", base, colleagueToken)).json().data as { id: string, isOwner: boolean, ownerName: string }[];
      expect(theirs.find(v => v.id === viewId)).toMatchObject({ isOwner: false, ownerName: "x" });
      expect((await call("PATCH", `${base}/${viewId}`, colleagueToken, { data: { name: "Mine now" } })).statusCode).toBe(404);
      expect((await call("DELETE", `${base}/${viewId}`, colleagueToken)).statusCode).toBe(404);

      // Its owner renames it and saves over it.
      const renamed = await call("PATCH", `${base}/${viewId}`, viewerToken, { data: { name: "Orán en tarjetas", config: { layout: "MAP" } } });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json().data).toMatchObject({ name: "Orán en tarjetas", config: { layout: "MAP" }, sharedCount: 2 });

      const recipients = (await call("GET", `${base}/${viewId}/shares`, viewerToken)).json().data as { kind: string }[];
      expect(recipients.map(r => r.kind)).toEqual(["ROLE", "USER"]);
      expect((await call("DELETE", `${base}/${viewId}/shares/${viewerRoleId}`, viewerToken)).statusCode).toBe(204);
      expect((await call("DELETE", `${base}/${viewId}/shares/${colleagueId}`, viewerToken)).statusCode).toBe(204);
      expect(((await call("GET", base, colleagueToken)).json().data as { id: string }[]).some(v => v.id === viewId)).toBe(false);
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews_states WHERE id = $1`, [viewId]);
    }
  });

  it("answers 400, not 500, to a prefs or saved-view write without a { data } body", async () => {
    for (const [method, url] of [["PUT", `/app/api/dataviews/${dataviewId}/user-prefs`], ["POST", `/app/api/dataviews/${dataviewId}/saved-views`]] as const) {
      expect((await call(method, url, viewerToken)).statusCode, url).toBe(400);
      expect((await call(method, url, viewerToken, { name: "No envelope", config: {} })).statusCode, url).toBe(400);
      expect((await call(method, url, viewerToken, { data: { name: "No config" } })).statusCode, url).toBe(400);
    }
  });

  it("addresses a DataView by its slug or its id, on every route", async () => {
    const slug = `${P}-dv`;
    const bySlug = await call("GET", `/app/api/dataviews/${slug}`, viewerToken);
    expect(bySlug.statusCode, bySlug.body).toBe(200);
    expect(bySlug.json().data.id).toBe(dataviewId);
    expect((await call("GET", `/app/api/dataviews/${dataviewId}`, viewerToken)).json().data).toEqual(bySlug.json().data);
    expect((await call("GET", `/app/api/dataviews/${slug}/fields`, viewerToken)).json().data)
      .toEqual((await call("GET", `/app/api/dataviews/${dataviewId}/fields`, viewerToken)).json().data);
    expect((await call("GET", `/app/api/dataviews/${slug}/catalog`, viewerToken)).statusCode).toBe(200);
    expect((await call("GET", `/app/api/dataviews/${slug}/saved-views`, viewerToken)).statusCode).toBe(200);
    // The old /id/ duplicate is gone, and a slug the caller may not open reads as missing.
    expect((await call("GET", `/app/api/dataviews/id/${dataviewId}`, viewerToken)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/dataviews/${slug}`, otherToken)).statusCode).toBe(404);
  });

  it("records the bulk audit summary only for a resource the caller may read", async () => {
    const ok = await call("POST", "/app/api/audit/events", viewerToken, { data: { resource: resourceId, action: "EXPORT", rowCount: 3, format: "csv" } });
    expect(ok.statusCode, ok.body).toBe(201);
    const { id } = ok.json().data as { id: string };
    const { rows } = await database.query<{ action: string; resource: string }>(`SELECT action, resource FROM totalbase.logs WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ action: "EXPORT", resource: resourceId });
    expect((await call("POST", "/app/api/audit/events", otherToken, { data: { resource: resourceId, action: "EXPORT", rowCount: 3 } })).statusCode).toBe(404);
    expect((await call("POST", "/app/api/audit/events", viewerToken, { data: { resource: resourceId, action: "DELETE" } })).statusCode).toBe(400);
  });

  it("tells the viewer what they may do to its rows - New, editing and Delete only where their grants allow", async () => {
    const role = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE name = '${P}-viewer'`)).rows[0]!.id;
    const actions = async () => (await call("GET", `/app/api/dataviews/${dataviewId}`, viewerToken)).json().data.viewerActions;
    // From no write grant at all - earlier tests leave CREATE.
    for (const action of ["CREATE", "UPDATE", "DELETE"] as const) await context.permissions.delete(role, resourceId, action).catch(() => undefined);
    expect(await actions()).toEqual({ create: false, update: false, delete: false });
    await context.permissions.set(role, resourceId, "UPDATE", { effect: "ALLOW" });
    try {
      expect(await actions()).toEqual({ create: false, update: true, delete: false });
      await context.permissions.set(role, resourceId, "CREATE", { effect: "ALLOW" });
      expect(await actions()).toEqual({ create: true, update: true, delete: false });
      // The DataView's own Allow narrows them - a listing with no New (DataViews.md §5.1) - never widens them.
      await context.dataviewsAdmin.update(dataviewId, { viewConfig: { allow: ["update", "delete"] } });
      await context.dataviewsAdmin.publish(dataviewId, null);
      expect(await actions()).toEqual({ create: false, update: true, delete: false });
      // An embed of it narrows what's granted with its own Allow instead - the DataView's is for its own pages.
      expect((await call("GET", `/app/api/dataviews/${dataviewId}`, viewerToken)).json().data.grantedActions).toEqual({ create: true, update: true, delete: false });
      await context.dataviewsAdmin.update(dataviewId, { viewConfig: { allow: null } });
      await context.dataviewsAdmin.publish(dataviewId, null);
      expect(await actions()).toEqual({ create: true, update: true, delete: false });
    } finally {
      await context.permissions.delete(role, resourceId, "UPDATE").catch(() => undefined);
      await context.permissions.delete(role, resourceId, "CREATE").catch(() => undefined);
    }
  });

  it("marks an FK display join the viewer may not traverse, and lifts the mark once granted", async () => {
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}_owners CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE}_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    await database.query(`ALTER TABLE public.${TABLE} ADD FOREIGN KEY (owner) REFERENCES public.${TABLE}_owners (id)`);
    // What a foreign key shows is its table's (DataViews.md §15.5): owners' name, by default.
    const { rows: [owners] } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      [`public.${TABLE}_owners`, `${TABLE}_owners`],
    );
    try {
      const role = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE name = '${P}-viewer'`)).rows[0]!.id;
      const fields = await context.dataviewsAdmin.listFields(dataviewId);
      const owner = fields.find((f) => f.columnName === "owner")!;
      await context.dataviewsAdmin.updateField(dataviewId, owner.id, { widget: "USelectMenu" });
      await context.dataviewsAdmin.publish(dataviewId, null);
      const ownerField = async () => ((await call("GET", `/app/api/dataviews/${dataviewId}/fields`, viewerToken)).json().data as Array<{ columnName: string; config: Record<string, unknown> }>).find((f) => f.columnName === "owner");

      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect((await ownerField())?.config.display_field_denied).toBe(true);

      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner", "owner.name"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect((await ownerField())?.config.display_field_denied).toBeUndefined();

      // A display template joins each of its columns: one not granted marks it too.
      await database.query(`UPDATE totalbase.resources SET row_presentation = '{"displayTemplate": "{{name}} ({{id}})"}' WHERE id = $1`, [owners!.id]);
      await context.dataviewsAdmin.publish(dataviewId, null);
      expect((await ownerField())?.config.display_field_denied).toBe(true);
      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner", "owner.name", "owner.id"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect((await ownerField())?.config.display_field_denied).toBeUndefined();
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [owners!.id]);
      await database.query(`DROP TABLE IF EXISTS public.${TABLE}_owners CASCADE`);
    }
  });

  it("lists the formulas' fk.related paths the viewer may not read, so the grid never asks for them", async () => {
    const owners = `${TABLE}_frm_owners`;
    await database.query(`DROP TABLE IF EXISTS public.${owners} CASCADE`);
    await database.query(`CREATE TABLE public.${owners} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    await database.query(`ALTER TABLE public.${TABLE} ADD CONSTRAINT ${TABLE}_frm_owner_fk FOREIGN KEY (owner) REFERENCES public.${owners} (id)`);
    try {
      const role = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE name = '${P}-viewer'`)).rows[0]!.id;
      await context.dataviewsAdmin.update(dataviewId, { viewConfig: { card_layout: { titleFormula: "{{name}} - {{owner.name}}" } } });
      await context.dataviewsAdmin.publish(dataviewId, null);
      const denied = async () => (await call("GET", `/app/api/dataviews/${dataviewId}`, viewerToken)).json().data.deniedRelationPaths;

      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect(await denied()).toEqual(["owner.name"]);
      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner", "owner.name"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect(await denied()).toEqual([]);
    } finally {
      await database.query(`DROP TABLE IF EXISTS public.${owners} CASCADE`);
    }
  });

  it("leaves out a related column (RELATED) the viewer may not read, and shows it once its path is granted", async () => {
    const owners = `${TABLE}_rel_owners`;
    await database.query(`DROP TABLE IF EXISTS public.${owners} CASCADE`);
    await database.query(`CREATE TABLE public.${owners} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    await database.query(`ALTER TABLE public.${TABLE} ADD CONSTRAINT ${TABLE}_rel_owner_fk FOREIGN KEY (owner) REFERENCES public.${owners} (id)`);
    const ownersResource = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1::regclass::oid::int, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      [`public.${owners}`, owners],
    )).rows[0]!.id;
    let relatedId: string | undefined;
    try {
      const role = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE name = '${P}-viewer'`)).rows[0]!.id;
      const [related] = await context.dataviewsAdmin.addColumns(dataviewId, ["owner.name"]);
      relatedId = related!.id;
      await context.dataviewsAdmin.publish(dataviewId, null);
      const relatedField = async () => ((await call("GET", `/app/api/dataviews/${dataviewId}/fields`, viewerToken)).json().data as Array<{ kind: string; columnName: string }>).find((f) => f.columnName === "owner.name");

      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect(await relatedField()).toBeUndefined();

      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner", "owner.name"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect(await relatedField()).toMatchObject({ kind: "RELATED", columnName: "owner.name" });
      // The grid's Filter offers it, typed - and only to whoever may read it.
      const catalog = async () => (await call("GET", `/app/api/dataviews/${dataviewId}/catalog`, viewerToken)).json().data.relatedColumns;
      expect(await catalog()).toEqual({ "owner.name": "text" });
      await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: ["id", "name", "owner"].map((field) => ({ field, effect: "ALLOW" as const })) });
      expect(await catalog()).toEqual({});
    } finally {
      if (relatedId) await context.dataviewsAdmin.deleteField(dataviewId, relatedId);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [ownersResource]);
      await database.query(`DROP TABLE IF EXISTS public.${owners} CASCADE`);
    }
  });
});
