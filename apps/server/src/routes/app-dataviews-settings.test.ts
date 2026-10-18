import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

const P = "app-dv-settings-test";
const TABLE = "app_dv_settings_test_params";
const PASSWORD = "a-strong-enough-password";
const LAYOUT = { keyColumn: "clave", valueColumn: "valor", titleColumn: "titulo", descriptionColumn: "descripcion", groupColumn: "grupo", orderColumn: "orden" };

/**
 * A SETTINGS DataView (Specification_DataViews.md §5.12): its layout's columns are checked when it is
 * created, and which settings a viewer may change is the Permission Resolver's answer - UPDATE's
 * fields and row filter - so a row shows locked before anyone tries to save it.
 */
describe("SETTINGS DataViews", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let resourceId: string;
  let editorToken: string;
  let readerToken: string;
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const dataviewIds: string[] = [];

  async function login(email: string, roleId: string): Promise<string> {
    const user = await context.auth.users.create({ email, name: "x", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    userIds.push(user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return (await context.auth.login({ email, password: PASSWORD })).token;
  }
  const writable = (token: string) =>
    app.inject({ method: "GET", url: `/app/api/dataviews/${P}-dv/settings-writable`, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(
      `CREATE TABLE public.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), clave text NOT NULL UNIQUE, titulo text NOT NULL,
         descripcion text NOT NULL, grupo text, orden integer, valor jsonb NOT NULL)`,
    );
    await database.query(
      `INSERT INTO public.${TABLE} (clave, titulo, descripcion, grupo, orden, valor) VALUES
         ('dias', 'Días', 'Cuántos días', 'General', 1, '30'), ('activo', 'Activo', 'Si está activo', 'General', 2, 'true'),
         ('ultima', 'Última ejecución', 'La pone el sistema', 'Sistema', 1, '"2026-01-01"')`,
    );
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.${TABLE}')::oid, 'public', '${TABLE}', 'TABLE', 'ACTIVE', ARRAY['GET','PATCH']) RETURNING id`,
    )).rows[0]!.id;

    const editor = (await context.roles.create(`${P}-editor`, { appAccess: true })).id;
    const reader = (await context.roles.create(`${P}-reader`, { appAccess: true })).id;
    roleIds.push(editor, reader);
    const every = ["id", "clave", "titulo", "descripcion", "grupo", "orden", "valor"].map((field) => ({ field, effect: "ALLOW" as const }));
    for (const role of [editor, reader]) await context.permissions.set(role, resourceId, "READ", { effect: "ALLOW", fields: every });
    // The editor changes every value but the one the system sets.
    await context.permissions.set(editor, resourceId, "UPDATE", { effect: "ALLOW", fields: [{ field: "valor", effect: "ALLOW" }], where: { clave: { _neq: "ultima" } } });
    editorToken = await login(`${P}-editor@example.com`, editor);
    readerToken = await login(`${P}-reader@example.com`, reader);

    const dataview = await context.dataviewsAdmin.create({ name: "Settings Test", slug: `${P}-dv`, sourceResourceId: resourceId, viewType: "SETTINGS", viewConfig: { settings_layout: LAYOUT } });
    dataviewIds.push(dataview.id);
    await context.dataviewsAdmin.setRoles(dataview.id, [editor, reader]);
    await context.dataviewsAdmin.publish(dataview.id, null);
  });

  afterAll(async () => {
    for (const id of dataviewIds) await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [id]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of roleIds) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
  });

  it("refuses a SETTINGS DataView without its four columns, or with one its source doesn't have", async () => {
    await expect(context.dataviewsAdmin.create({ name: "Settings Bad", sourceResourceId: resourceId, viewType: "SETTINGS", viewConfig: { settings_layout: { keyColumn: "clave", valueColumn: "valor" } } }))
      .rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" });
    await expect(context.dataviewsAdmin.create({ name: "Settings Bad", sourceResourceId: resourceId, viewType: "SETTINGS", viewConfig: { settings_layout: { ...LAYOUT, valueColumn: "nope" } } }))
      .rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" });
  });

  it("tells a viewer the settings their UPDATE's row filter lets them change", async () => {
    const res = await writable(editorToken);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { valueWritable: boolean; keys: string[] | null };
    expect(data.valueWritable).toBe(true);
    expect([...(data.keys ?? [])].sort()).toEqual(["activo", "dias"]);
  });

  it("locks every setting for a viewer with no UPDATE", async () => {
    const res = await writable(readerToken);
    expect(res.json().data).toEqual({ valueWritable: false, keys: [] });
  });
});
