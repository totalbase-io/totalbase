import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Route-level acceptance tests for the READ-gated /pdf action on
 * totalbase.templates (Administration.md §9.4):
 * rendering is reading, refused with TEMPLATE_ACCESS_DENIED - the shared
 * check (@totalbase/mutations' assertTemplateReadAllowed) the workflow
 * template steps use too. A MAILING template (inserted directly here)
 * exercises the route's kind check.
 */
describe("Templates actions (/pdf)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let apiKeyPlain: string;
  let apiKeyUserId: string;
  let pdfTemplateId: string;
  let mailingTemplateId: string;
  let templatesResourceId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    const role = await context.roles.create("templates-pkg-test-role", { apiAccess: true });
    roleId = role.id;
    const created = await createTestApiToken(context, {
      name: "templates-pkg-test-key",
      roleId,
      email: "templates-pkg-test-key@example.com",
    });
    apiKeyPlain = created.plainKey;
    apiKeyUserId = created.userId;

    const { rows: pdfRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.templates (name, slug, kind, content)
       VALUES ('templates-pkg-test-pdf', 'templates-pkg-test-pdf', 'PDF', $1::jsonb)
       RETURNING id`,
      [
        JSON.stringify({
          basePdf: { width: 210, height: 297, padding: [10, 10, 10, 10] },
          schemas: [{ greeting: { type: "text", position: { x: 20, y: 20 }, width: 100, height: 20, fontSize: 14 } }],
        }),
      ],
    );
    pdfTemplateId = pdfRows[0]!.id;

    const { rows: mailingRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.templates (name, slug, kind, content)
       VALUES ('templates-pkg-test-mail', 'templates-pkg-test-mail', 'MAILING', $1::jsonb)
       RETURNING id`,
      [JSON.stringify({ subject: "Hola {{ nombre }}", message: "Bienvenido {{ nombre }}" })],
    );
    mailingTemplateId = mailingRows[0]!.id;

    const resourceRow = await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE schema = 'totalbase' AND name = 'templates'`,
    );
    templatesResourceId = resourceRow.rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.templates WHERE id = ANY($1)`, [[pdfTemplateId, mailingTemplateId]]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
    await database.close();
  });

  // The name CHECK refused "Factura A (AFIP)" though validateName - every service's and the admin's rule - takes it.
  it("takes a title's punctuation in a template's name, as validateName does, and refuses a path separator", async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.templates (name, slug, kind, content) VALUES ('Factura A (AFIP)', 'templates-pkg-test-afip', 'MAILING', '{"subject": "s", "message": "m"}'::jsonb) RETURNING id`,
    );
    await database.query(`DELETE FROM totalbase.templates WHERE id = $1`, [rows[0]!.id]);
    await expect(
      database.query(`INSERT INTO totalbase.templates (name, slug, kind, content) VALUES ('Ventas/2026', 'templates-pkg-test-slash', 'MAILING', '{"subject": "s", "message": "m"}'::jsonb)`),
    ).rejects.toMatchObject({ code: "CHECK_VIOLATION", message: expect.stringContaining("- _ . , : ; ( ) ' & + only") });
  });

  it("denies /pdf with no grant, then allows it once READ is granted", async () => {
    const denied = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/templates/${pdfTemplateId}/pdf`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { greeting: "Hola Cesar" } },
    });
    expect([denied.statusCode, denied.json().errors[0].code]).toEqual([403, "TEMPLATE_ACCESS_DENIED"]);

    await context.permissions.set(roleId, templatesResourceId, "READ", { effect: "ALLOW" });

    const allowed = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/templates/${pdfTemplateId}/pdf`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { greeting: "Hola Cesar" } },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["content-type"]).toBe("application/pdf");
    expect(allowed.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    await context.permissions.delete(roleId, templatesResourceId, "READ");
  });

  // Regression: the resource lookup and the row-filter compile both used
  // the pre-000084 schema ('public'), so every /pdf call failed closed with
  // ACTION_DENIED - including this scoped-grant path, which also has to
  // load the table's catalog metadata from the right schema.
  it("honors a row-filtered READ grant: allows the matching template, denies another", async () => {
    await context.permissions.set(roleId, templatesResourceId, "READ", {
      effect: "ALLOW",
      where: { slug: { _eq: "templates-pkg-test-pdf" } },
    });

    const allowed = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/templates/${pdfTemplateId}/pdf`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { greeting: "Hola" } },
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/templates/${mailingTemplateId}/pdf`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: {},
    });
    expect([denied.statusCode, denied.json().errors[0].code]).toEqual([403, "TEMPLATE_ACCESS_DENIED"]);

    await context.permissions.delete(roleId, templatesResourceId, "READ");
  });

  it("rejects /pdf against a MAILING-kind template (wrong kind)", async () => {
    await context.permissions.set(roleId, templatesResourceId, "READ", { effect: "ALLOW" });

    const res = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/templates/${mailingTemplateId}/pdf`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: {},
    });
    expect(res.json().errors[0].code).toBe("TEMPLATE_WRONG_KIND");

    await context.permissions.delete(roleId, templatesResourceId, "READ");
  });
});
