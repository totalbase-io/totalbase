import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp, uniqueSuffix } from "../test-support.js";

// Short: a slug is at most 32 characters.
const PREFIX = `am-${uniqueSuffix()}`;
const PASSWORD = "a-strong-enough-password";

interface Node { kind: string; id: string; name: string; icon?: string | null; children?: Node[] }
/** A menu as GET returns it, in the shape PUT takes. */
function asInput(nodes: Node[]): unknown[] {
  return nodes.map((n) => (n.kind === "GROUP" ? { kind: "GROUP", id: n.id, name: n.name, icon: n.icon ?? null, children: asInput(n.children ?? []) } : { kind: n.kind, id: n.id }));
}
/** Every object id in a menu, groups flattened away. */
function objectIds(nodes: Node[]): string[] {
  return nodes.flatMap((node) => (node.kind === "GROUP" ? objectIds(node.children ?? []) : [node.id]));
}

/**
 * The App menu and object access (Security.md §7.1, §8):
 * a DataView shows for a viewer only with its object access AND READ on
 * its source; a Dashboard with its object access; a group left empty is
 * hidden; an embedded DataView opens through the one embedding it; the
 * administrator sees and arranges everything; publishing appends.
 */
describe("App menu (/app/api/menu, /admin/api/app/menu)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let viewerToken: string;
  let otherToken: string;
  let readableResource: string;
  let unreadableResource: string;
  let viewerRole: string;
  const dv: Record<string, string> = {};
  const dash: Record<string, string> = {};
  /** Rows this file created - deleted by id in afterAll (a menu row goes with its object). */
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const resourceIds: string[] = [];
  /** The administrator's arrangement before this file touched it - restored in afterAll. */
  let menuSnapshot: Node[] = [];

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });

  async function viewer(email: string, roleId: string): Promise<string> {
    const user = await context.auth.users.create({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    userIds.push(user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return (await context.auth.login({ email, password: PASSWORD })).token;
  }

  async function table(name: string): Promise<string> {
    await database.query(`DROP TABLE IF EXISTS public.${name} CASCADE`);
    await database.query(`CREATE TABLE public.${name} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
      [`public.${name}`, name],
    );
    resourceIds.push(rows[0]!.id);
    return rows[0]!.id;
  }
  async function role(name: string): Promise<string> {
    const created = await context.roles.create(name, { appAccess: true });
    roleIds.push(created.id);
    return created.id;
  }

  async function dataview(key: string, resourceId: string, roles: string[], publish = true): Promise<string> {
    const created = await context.dataviewsAdmin.create({ name: `${PREFIX} ${key}`, slug: `${PREFIX}-${key}`, sourceResourceId: resourceId, viewType: "TABLE" });
    if (roles.length > 0) await context.dataviewsAdmin.setRoles(created.id, roles);
    if (publish) await context.dataviewsAdmin.publish(created.id, null);
    dv[key] = created.id;
    return created.id;
  }

  async function dashboard(key: string, roles: string[]): Promise<string> {
    const created = await context.dashboardsAdmin.create({ name: `${PREFIX} ${key}`, slug: `${PREFIX}-${key}` });
    if (roles.length > 0) await context.dashboardsAdmin.setRoles(created.id, roles);
    await context.dashboardsAdmin.publish(created.id, null);
    return created.id;
  }

  async function cleanup(): Promise<void> {
    // Embeds first - the related-DataView FK is RESTRICT, so the order rows go in would decide it.
    const dataviewIds = [...new Set(Object.values(dv))];
    await database.query(`DELETE FROM totalbase.dataviews_fields WHERE related_dataview = ANY($1)`, [dataviewIds]);
    for (const id of dataviewIds.reverse()) await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [id]);
    for (const id of Object.values(dash)) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of roleIds) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    for (const id of resourceIds) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
    await database.query(`DROP TABLE IF EXISTS public.app_menu_test_items, public.app_menu_test_secrets CASCADE`);
    // The objects above took their menu rows with them; this puts the groups and order back as they were.
    const restored = await call("PUT", "/admin/api/app/menu", adminToken, { data: { nodes: asInput(menuSnapshot) } });
    if (restored.statusCode !== 200) throw new Error(`menu restore failed: ${restored.body}`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    menuSnapshot = (await call("GET", "/admin/api/app/menu", adminToken)).json().data.nodes;

    readableResource = await table("app_menu_test_items");
    unreadableResource = await table("app_menu_test_secrets");
    viewerRole = await role(`${PREFIX}-viewer`);
    const otherRole = await role(`${PREFIX}-other`);
    await context.permissions.set(viewerRole, readableResource, "READ", { effect: "ALLOW" });
    await context.permissions.set(otherRole, readableResource, "READ", { effect: "ALLOW" });
    viewerToken = await viewer(`${PREFIX}-viewer@example.com`, viewerRole);
    otherToken = await viewer(`${PREFIX}-other@example.com`, otherRole);

    dv.granted = await dataview("granted", readableResource, [viewerRole]);
    dv.ungranted = await dataview("ungranted", readableResource, []);
    dv.noRead = await dataview("no-read", unreadableResource, [viewerRole]);
    dv.draft = await dataview("draft", readableResource, [viewerRole], false);
    // Shown by an embed in `granted` (republished so its live version carries it), granted to nobody.
    dv.embedded = await dataview("embedded", readableResource, []);
    await context.dataviewsAdmin.addWidget(dv.granted!, { widget: "TDataView", config: { props: { dataview: dv.embedded! } } });
    await context.dataviewsAdmin.publish(dv.granted!, null);
    dash.granted = await dashboard("dash-granted", [viewerRole]);
    dash.ungranted = await dashboard("dash-ungranted", []);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("needs a signed-in portal user, and only an administrator arranges it", async () => {
    expect((await app.inject({ method: "GET", url: "/app/api/menu" })).statusCode).toBe(401);
    expect((await call("GET", "/admin/api/app/menu", viewerToken)).statusCode).toBe(403);
    expect((await call("PUT", "/admin/api/app/menu", viewerToken, { data: { nodes: [] } })).statusCode).toBe(403);
  });

  it("shows the administrator every published object, drafts excluded", async () => {
    const ids = objectIds((await call("GET", "/admin/api/app/menu", adminToken)).json().data.nodes);
    for (const id of [dv.granted, dv.ungranted, dv.noRead, dv.embedded, dash.granted, dash.ungranted]) expect(ids).toContain(id);
    expect(ids).not.toContain(dv.draft);
  });

  it("shows a viewer a DataView only with object access and READ on its source, a Dashboard with object access", async () => {
    const ids = objectIds((await call("GET", "/app/api/menu", viewerToken)).json().data.nodes);
    expect(ids).toContain(dv.granted);
    expect(ids).toContain(dash.granted);
    for (const id of [dv.ungranted, dv.noRead, dv.draft, dv.embedded, dash.ungranted]) expect(ids).not.toContain(id);
    expect(objectIds((await call("GET", "/app/api/menu", otherToken)).json().data.nodes).filter((id) => Object.values(dv).includes(id) || Object.values(dash).includes(id))).toEqual([]);
  });

  it("follows the administrator's arrangement and hides a group with nothing visible for the viewer", async () => {
    const saved = await call("PUT", "/admin/api/app/menu", adminToken, {
      data: {
        nodes: [
          { kind: "GROUP", name: "Hidden for viewer", children: [{ kind: "DATAVIEW", id: dv.noRead }] },
          { kind: "GROUP", name: "Visible", children: [{ kind: "GROUP", name: "Sub", children: [{ kind: "DASHBOARD", id: dash.granted }] }] },
          { kind: "DATAVIEW", id: dv.granted },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const adminNodes: Node[] = saved.json().data.nodes;
    expect(adminNodes.slice(0, 3).map((n) => n.name)).toEqual(["Hidden for viewer", "Visible", `${PREFIX} granted`]);

    const viewerNodes: Node[] = (await call("GET", "/app/api/menu", viewerToken)).json().data.nodes;
    expect(viewerNodes.map((n) => n.name)).toEqual(["Visible", `${PREFIX} granted`]);
    expect(viewerNodes[0]!.children![0]!.children!.map((n) => n.id)).toEqual([dash.granted]);
  });

  it("appends a newly published object to the end of the root, and drops a deleted one", async () => {
    // The admin UI always saves the whole tree, so a new object is the only unplaced one.
    const current: Node[] = (await call("GET", "/admin/api/app/menu", adminToken)).json().data.nodes;
    expect((await call("PUT", "/admin/api/app/menu", adminToken, { data: { nodes: asInput(current) } })).statusCode).toBe(200);
    const fresh = await dataview("fresh", readableResource, []);
    const nodes: Node[] = (await call("GET", "/admin/api/app/menu", adminToken)).json().data.nodes;
    expect(nodes.at(-1)!.id).toBe(fresh);

    await context.dataviewsAdmin.delete(fresh);
    expect(objectIds((await call("GET", "/admin/api/app/menu", adminToken)).json().data.nodes)).not.toContain(fresh);
  });

  it("refuses a malformed arrangement, an unknown object and one placed twice - leaving the menu as it was", async () => {
    const before = (await call("GET", "/admin/api/app/menu", adminToken)).json().data.nodes;
    const bad = [
      {},
      { nodes: [{ kind: "GROUP", children: [] }] },
      { nodes: [{ kind: "WIDGET", id: dv.granted }] },
      { nodes: [{ kind: "GROUP", name: "   ", children: [] }] },
      { nodes: [{ kind: "DATAVIEW", id: "00000000-0000-0000-0000-000000000000" }] },
      { nodes: [{ kind: "DATAVIEW", id: dv.granted }, { kind: "GROUP", name: "Again", children: [{ kind: "DATAVIEW", id: dv.granted }] }] },
    ];
    for (const payload of bad) {
      const res = await call("PUT", "/admin/api/app/menu", adminToken, { data: payload });
      expect(res.statusCode, JSON.stringify(payload)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, JSON.stringify(payload)).toBeLessThan(500);
    }
    expect((await call("GET", "/admin/api/app/menu", adminToken)).json().data.nodes).toEqual(before);
    // Without the { data } envelope: 400.
    expect((await call("PUT", "/admin/api/app/menu", adminToken, { nodes: [] })).statusCode).toBe(400);
  });

  it("lists hidden objects apart, and moves one between the menu and Hidden by its scope", async () => {
    const menu = async () => (await call("GET", "/admin/api/app/menu", adminToken)).json().data as { nodes: Node[]; hidden: Node[] };
    const hiddenIds = async () => (await menu()).hidden.map((n) => n.id);
    // A Detail's own DataView is EMBEDDED_ONLY by design: never offered.
    const owned = await dataview("owned", readableResource, []);
    await database.query(`UPDATE totalbase.dataviews SET scope = 'EMBEDDED_ONLY', owner = $1 WHERE id = $2`, [dv.granted, owned]);
    expect(await hiddenIds()).not.toContain(owned);
    expect(objectIds((await menu()).nodes)).not.toContain(owned);

    for (const [kind, id] of [["dataviews", dv.ungranted!], ["dashboards", dash.ungranted!]] as const) {
      const hide = await call("PATCH", `/admin/api/${kind}/${id}`, adminToken, { data: { scope: "EMBEDDED_ONLY" } });
      expect(hide.statusCode, hide.body).toBe(200);
      expect(objectIds((await menu()).nodes)).not.toContain(id);
      expect(await hiddenIds()).toContain(id);

      expect((await call("PATCH", `/admin/api/${kind}/${id}`, adminToken, { data: { scope: "LISTED" } })).statusCode).toBe(200);
      expect(objectIds((await menu()).nodes)).toContain(id);
      expect(await hiddenIds()).not.toContain(id);
    }
    // Drafts are never offered either.
    await context.dataviewsAdmin.update(dv.draft!, { scope: "EMBEDDED_ONLY" });
    expect(await hiddenIds()).not.toContain(dv.draft);
  });

  it("reports the display mode", async () => {
    expect((await call("GET", "/app/api/menu", viewerToken)).json().data.mode).toBe("TREE");
    await context.settings.set("app.menu_mode", "SIDEBAR");
    try {
      expect((await call("GET", "/app/api/menu", viewerToken)).json().data.mode).toBe("SIDEBAR");
    } finally {
      await context.settings.set("app.menu_mode", "TREE");
    }
    await expect(context.settings.set("app.menu_mode", "GRID")).rejects.toMatchObject({ code: "INVALID_SETTING" });
  });

  it("opens a role's home - the first by role name its member sees in the menu, never one they don't (T58)", async () => {
    const home = async (token: string) => (await call("GET", "/app/api/menu", token)).json().data.home;
    expect(await home(viewerToken)).toBeNull();
    const second = await role(`${PREFIX}-viewer-z`);
    await context.roleAssignments.assignRoleToUser((await context.auth.users.findByEmail(`${PREFIX}-viewer@example.com`))!.id, second);
    await database.query(`UPDATE totalbase.roles SET home_dashboard = $2 WHERE id = $1`, [second, dash.granted]);
    // Its first role's home is one it can't open: the next one's.
    await database.query(`UPDATE totalbase.roles SET home_dataview = $2 WHERE id = $1`, [viewerRole, dv.ungranted]);
    expect(await home(viewerToken)).toEqual({ kind: "DASHBOARD", slug: `${PREFIX}-dash-granted` });
    await database.query(`UPDATE totalbase.roles SET home_dataview = $2 WHERE id = $1`, [viewerRole, dv.granted]);
    expect(await home(viewerToken)).toEqual({ kind: "DATAVIEW", slug: `${PREFIX}-granted` });
    // One home per role, as PostgreSQL holds it.
    await expect(database.query(`UPDATE totalbase.roles SET home_dashboard = $2 WHERE id = $1`, [viewerRole, dash.granted])).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    expect(await home(otherToken)).toBeNull();
  });
});

describe("Object access on /app/api/dataviews", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let viewerToken: string;
  let otherToken: string;
  let resourceId: string;
  const dv: Record<string, string> = {};
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const P = `adv-${uniqueSuffix()}`;

  const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function cleanup(): Promise<void> {
    // Embeds first - the related-DataView FK is RESTRICT, so the order rows go in would decide it.
    const dataviewIds = Object.values(dv);
    await database.query(`DELETE FROM totalbase.dataviews_fields WHERE related_dataview = ANY($1)`, [dataviewIds]);
    for (const id of dataviewIds.reverse()) await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [id]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of roleIds) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    if (resourceId) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.app_dv_access_test_items CASCADE`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.app_dv_access_test_items CASCADE`);
    await database.query(`CREATE TABLE public.app_dv_access_test_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.app_dv_access_test_items')::oid, 'public', 'app_dv_access_test_items', 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
    )).rows[0]!.id;
    const viewerRole = (await context.roles.create(`${P}-viewer`, { appAccess: true })).id;
    const otherRole = (await context.roles.create(`${P}-other`, { appAccess: true })).id;
    roleIds.push(viewerRole, otherRole);
    for (const role of [viewerRole, otherRole]) await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW" });
    for (const [email, role] of [[`${P}-viewer@example.com`, viewerRole], [`${P}-other@example.com`, otherRole]] as const) {
      const user = await context.auth.users.create({ email, name: "x", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
      userIds.push(user.id);
      await context.roleAssignments.assignRoleToUser(user.id, role);
    }
    viewerToken = (await context.auth.login({ email: `${P}-viewer@example.com`, password: PASSWORD })).token;
    otherToken = (await context.auth.login({ email: `${P}-other@example.com`, password: PASSWORD })).token;

    const make = async (key: string, roles: string[]) => {
      const created = await context.dataviewsAdmin.create({ name: `${P} ${key}`, slug: `${P}-${key}`, sourceResourceId: resourceId, viewType: "TABLE" });
      await context.dataviewsAdmin.setRoles(created.id, roles);
      return created.id;
    };
    dv.host = await make("host", [viewerRole]);
    dv.inner = await make("inner", []);
    dv.deepest = await make("deepest", []);
    dv.stranger = await make("stranger", []);
    await context.dataviewsAdmin.addWidget(dv.inner!, { widget: "TDataView", config: { props: { dataview: dv.deepest! } } });
    await context.dataviewsAdmin.addWidget(dv.host!, { widget: "TDataView", config: { props: { dataview: dv.inner! } } });
    for (const id of Object.values(dv)) await context.dataviewsAdmin.publish(id, null);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("lists only DataViews granted to the viewer - not merely readable ones", async () => {
    const slugs = ((await get("/app/api/dataviews", viewerToken)).json().data as Array<{ slug: string }>).map((v) => v.slug);
    expect(slugs).toContain(`${P}-host`);
    for (const key of ["inner", "deepest", "stranger"]) expect(slugs).not.toContain(`${P}-${key}`);
  });

  it("opens a DataView embedded (at any depth) in one the viewer may open, and nothing else", async () => {
    for (const key of ["host", "inner", "deepest"]) {
      expect((await get(`/app/api/dataviews/${dv[key]}`, viewerToken)).statusCode, key).toBe(200);
    }
    const denied = await get(`/app/api/dataviews/${P}-stranger`, viewerToken);
    const missing = await get(`/app/api/dataviews/${P}-nope`, viewerToken);
    expect(denied.statusCode).toBe(404);
    expect(denied.json().errors[0].code).toBe(missing.json().errors[0].code);
    for (const key of ["host", "inner", "deepest"]) {
      expect((await get(`/app/api/dataviews/${dv[key]}/fields`, otherToken)).statusCode, key).toBe(404);
    }
  });

  it("stops granting the moment object access is removed", async () => {
    await context.dataviewsAdmin.setRoles(dv.host!, []);
    expect((await get(`/app/api/dataviews/${P}-host`, viewerToken)).statusCode).toBe(404);
    expect((await get(`/app/api/dataviews/${dv.deepest}`, viewerToken)).statusCode).toBe(404);
  });
});
