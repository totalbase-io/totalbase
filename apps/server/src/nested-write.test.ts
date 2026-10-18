import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Acceptance tests for nested writes (Specification_Data_API.md §6).
 * Only nested CREATE is implemented in this release (Roadmap_v3.md §2.1)
 * - nested UPDATE cases are intentionally not covered here.
 */
describe("Nested writes (CREATE only)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;

  let invoicesId: string;
  let invoiceItemsId: string;
  let invoiceItemTaxesId: string;
  let invoicePaymentsId: string;
  let roleId: string;
  let apiKeyId: string;
  let apiKeyPlain: string;
  let apiKeyUserId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoice_item_taxes CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoice_payments CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoice_items CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoices CASCADE`);

    await database.query(`
      CREATE TABLE public.nw_pkg_test_invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        number integer NOT NULL,
        customer text
      )
    `);
    await database.query(`
      CREATE TABLE public.nw_pkg_test_invoice_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice uuid NOT NULL REFERENCES public.nw_pkg_test_invoices (id),
        product text NOT NULL,
        quantity integer NOT NULL CHECK (quantity > 0)
      )
    `);
    await database.query(`
      CREATE TABLE public.nw_pkg_test_invoice_item_taxes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_item uuid NOT NULL REFERENCES public.nw_pkg_test_invoice_items (id),
        tax text NOT NULL,
        rate numeric NOT NULL
      )
    `);
    await database.query(`
      CREATE TABLE public.nw_pkg_test_invoice_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice uuid NOT NULL REFERENCES public.nw_pkg_test_invoices (id),
        amount numeric NOT NULL
      )
    `);

    const resources = await database.query<{ name: string; id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES
         (to_regclass('public.nw_pkg_test_invoices')::oid, 'public', 'nw_pkg_test_invoices', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}'),
         (to_regclass('public.nw_pkg_test_invoice_items')::oid, 'public', 'nw_pkg_test_invoice_items', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}'),
         (to_regclass('public.nw_pkg_test_invoice_item_taxes')::oid, 'public', 'nw_pkg_test_invoice_item_taxes', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}'),
         (to_regclass('public.nw_pkg_test_invoice_payments')::oid, 'public', 'nw_pkg_test_invoice_payments', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}')
       RETURNING name, id`,
    );
    const byName = Object.fromEntries(resources.rows.map((r) => [r.name, r.id]));
    invoicesId = byName["nw_pkg_test_invoices"]!;
    invoiceItemsId = byName["nw_pkg_test_invoice_items"]!;
    invoiceItemTaxesId = byName["nw_pkg_test_invoice_item_taxes"]!;
    invoicePaymentsId = byName["nw_pkg_test_invoice_payments"]!;

    const role = await context.roles.create("nw-pkg-test-role", { apiAccess: true });
    roleId = role.id;

    for (const [resourceId, createFields] of [
      [invoicesId, ["number", "customer"]],
      [invoiceItemsId, ["invoice", "product", "quantity"]],
      [invoiceItemTaxesId, ["invoice_item", "tax", "rate"]],
      [invoicePaymentsId, ["invoice", "amount"]],
    ] as const) {
      await context.permissions.set(roleId, resourceId, "READ", {
        effect: "ALLOW",
        fields: [...createFields.map((f) => ({ field: f as string, effect: "ALLOW" as const })), { field: "id", effect: "ALLOW" as const }],
      });
      await context.permissions.set(roleId, resourceId, "CREATE", {
        effect: "ALLOW",
        fields: createFields.map((f) => ({ field: f, effect: "ALLOW" as const })),
      });
    }

    const created = await createTestApiToken(context, {
      name: "nw-pkg-test-key",
      roleId,
      email: "nw-pkg-test-key@example.com",
    });
    apiKeyPlain = created.plainKey;
    apiKeyId = created.tokenId;
    apiKeyUserId = created.userId;
  });

  afterEach(async () => {
    await database.query(`DELETE FROM public.nw_pkg_test_invoice_item_taxes`);
    await database.query(`DELETE FROM public.nw_pkg_test_invoice_payments`);
    await database.query(`DELETE FROM public.nw_pkg_test_invoice_items`);
    await database.query(`DELETE FROM public.nw_pkg_test_invoices`);
    await context.settings.set("api.nested_write_max_depth", 2);
    await context.settings.set("api.nested_write_max_records", 500);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(
      `DELETE FROM totalbase.resources WHERE id = ANY($1)`,
      [[invoicesId, invoiceItemsId, invoiceItemTaxesId, invoicePaymentsId]],
    );
    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoice_item_taxes CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoice_payments CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoice_items CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_invoices CASCADE`);
    await app.close();
    await database.close();
  });

  function post(payload: unknown) {
    return app.inject({
      method: "POST",
      url: "/api/public/table/nw_pkg_test_invoices",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: payload },
    });
  }

  describe("Create", () => {
    it("creates a parent with one nested child", async () => {
      const res = await post({
        number: 1,
        customer: "acme",
        $nw_pkg_test_invoice_items: [{ product: "widget", quantity: 2 }],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json().data;
      expect(body.number).toBe(1);
      expect(body.$nw_pkg_test_invoice_items).toHaveLength(1);
      expect(body.$nw_pkg_test_invoice_items[0].product).toBe("widget");
      expect(body.$nw_pkg_test_invoice_items[0].invoice).toBe(body.id);

      const { rows } = await database.query(`SELECT * FROM public.nw_pkg_test_invoice_items WHERE invoice = $1`, [body.id]);
      expect(rows).toHaveLength(1);
    });

    it("answers the parent as its children's triggers left it, not the INSERT's RETURNING from before them", async () => {
      // An order's totals recalculated from its lines (MCP_Demo_Findings.md F14).
      await database.query(`
        CREATE FUNCTION public.nw_pkg_test_count_items() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE public.nw_pkg_test_invoices
          SET customer = 'items: ' || (SELECT count(*) FROM public.nw_pkg_test_invoice_items WHERE invoice = NEW.invoice)
          WHERE id = NEW.invoice;
          RETURN NEW;
        END $$`);
      await database.query(`
        CREATE TRIGGER nw_pkg_test_count_items AFTER INSERT ON public.nw_pkg_test_invoice_items
        FOR EACH ROW EXECUTE FUNCTION public.nw_pkg_test_count_items()`);
      try {
        const res = await post({
          number: 10,
          customer: "before",
          $nw_pkg_test_invoice_items: [{ product: "a", quantity: 1 }, { product: "b", quantity: 1 }],
        });
        expect(res.statusCode).toBe(201);
        const body = res.json().data;
        expect(body.customer).toBe("items: 2");
        expect(body.number).toBe(10);
        expect(body.$nw_pkg_test_invoice_items).toHaveLength(2);
      } finally {
        await database.query(`DROP TRIGGER nw_pkg_test_count_items ON public.nw_pkg_test_invoice_items`);
        await database.query(`DROP FUNCTION public.nw_pkg_test_count_items()`);
      }
    });

    it("creates a parent with many children", async () => {
      const res = await post({
        number: 2,
        $nw_pkg_test_invoice_items: [
          { product: "a", quantity: 1 },
          { product: "b", quantity: 2 },
          { product: "c", quantity: 3 },
        ],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.$nw_pkg_test_invoice_items).toHaveLength(3);
    });

    it("creates a parent with multiple different child resources", async () => {
      const res = await post({
        number: 3,
        $nw_pkg_test_invoice_items: [{ product: "a", quantity: 1 }],
        $nw_pkg_test_invoice_payments: [{ amount: 100 }],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json().data;
      expect(body.$nw_pkg_test_invoice_items).toHaveLength(1);
      expect(body.$nw_pkg_test_invoice_payments).toHaveLength(1);
    });

    it("creates nested structures at depth 2 (grandchildren)", async () => {
      const res = await post({
        number: 4,
        $nw_pkg_test_invoice_items: [
          {
            product: "a",
            quantity: 1,
            $nw_pkg_test_invoice_item_taxes: [{ tax: "VAT", rate: 21 }],
          },
        ],
      });
      expect(res.statusCode).toBe(201);
      const item = res.json().data.$nw_pkg_test_invoice_items[0];
      expect(item.$nw_pkg_test_invoice_item_taxes).toHaveLength(1);
      expect(item.$nw_pkg_test_invoice_item_taxes[0].invoice_item).toBe(item.id);
    });

    it("rejects structures beyond the configured depth", async () => {
      await context.settings.set("api.nested_write_max_depth", 1);
      const res = await post({
        number: 5,
        $nw_pkg_test_invoice_items: [
          {
            product: "a",
            quantity: 1,
            $nw_pkg_test_invoice_item_taxes: [{ tax: "VAT", rate: 21 }],
          },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("NESTED_MAX_DEPTH_EXCEEDED");

      const { rows } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 5`);
      expect(rows).toHaveLength(0);
    });

    it("rejects requests beyond the configured record count", async () => {
      await context.settings.set("api.nested_write_max_records", 2);
      const res = await post({
        number: 6,
        $nw_pkg_test_invoice_items: [
          { product: "a", quantity: 1 },
          { product: "b", quantity: 1 },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("NESTED_MAX_RECORDS_EXCEEDED");

      const { rows } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 6`);
      expect(rows).toHaveLength(0);
    });

    it("rejects a nested child resource with no FK to the parent", async () => {
      const res = await post({
        number: 7,
        $nw_pkg_test_invoice_item_taxes: [{ tax: "VAT", rate: 21 }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("INVALID_NESTED_RELATION");
    });

    it("rejects an unknown nested relation name", async () => {
      const res = await post({ number: 8, $nonexistent_table: [{ x: 1 }] });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("INVALID_NESTED_RELATION");
    });

    it("checks an empty relation array like a non-empty one", async () => {
      const unknown = await post({ number: 9, $nonexistent_table: [] });
      expect([unknown.statusCode, unknown.json().errors[0].code]).toEqual([400, "INVALID_NESTED_RELATION"]);
      const unrelated = await post({ number: 9, $nw_pkg_test_invoice_item_taxes: [] });
      expect([unrelated.statusCode, unrelated.json().errors[0].code]).toEqual([400, "INVALID_NESTED_RELATION"]);
      const { rows } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 9`);
      expect(rows).toHaveLength(0);

      const valid = await post({ number: 9, customer: "acme", $nw_pkg_test_invoice_items: [] });
      expect(valid.statusCode, valid.body).toBe(201);
      expect(valid.json().data.$nw_pkg_test_invoice_items).toEqual([]);
    });

    it("rejects on_conflict on a nested CREATE instead of ignoring it", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/nw_pkg_test_invoices",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: { data: { number: 10, $nw_pkg_test_invoice_items: [{ product: "a", quantity: 1 }] }, on_conflict: { target: ["id"], action: "NOTHING" } },
      });
      expect([res.statusCode, res.json().errors[0].code]).toEqual([400, "UNSUPPORTED_NESTED_OPERATION"]);
      const { rows } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 10`);
      expect(rows).toHaveLength(0);
    });

    it("keeps api.nested_write_max_depth within 1-3 (INVALID_SETTING), no silent clamp", async () => {
      await expect(context.settings.set("api.nested_write_max_depth", 4)).rejects.toMatchObject({ code: "INVALID_SETTING" });
      await expect(context.settings.set("api.nested_write_max_depth", 0)).rejects.toMatchObject({ code: "INVALID_SETTING" });
      await context.settings.set("api.nested_write_max_depth", 3);
      await context.settings.set("api.nested_write_max_depth", 2);
    });

    it("rejects ambiguous child-to-parent foreign keys", async () => {
      await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_addresses CASCADE`);
      await database.query(`
        CREATE TABLE public.nw_pkg_test_addresses (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          billing_invoice uuid REFERENCES public.nw_pkg_test_invoices (id),
          shipping_invoice uuid REFERENCES public.nw_pkg_test_invoices (id),
          label text
        )
      `);
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES (to_regclass('public.nw_pkg_test_addresses')::oid, 'public', 'nw_pkg_test_addresses', 'TABLE', 'ACTIVE', '{GET,POST}')
         RETURNING id`,
      );
      const addressesId = rows[0]!.id;
      await context.permissions.set(roleId, addressesId, "CREATE", {
        effect: "ALLOW",
        fields: [{ field: "label", effect: "ALLOW" }],
      });

      try {
        const res = await post({ number: 9, $nw_pkg_test_addresses: [{ label: "home" }] });
        expect(res.statusCode).toBe(400);
        expect(res.json().errors[0].code).toBe("AMBIGUOUS_NESTED_RELATION");
      } finally {
        await database.query(`DELETE FROM totalbase.permissions WHERE resource = $1`, [addressesId]);
        await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [addressesId]);
        await database.query(`DROP TABLE IF EXISTS public.nw_pkg_test_addresses CASCADE`);
      }
    });

    it("rejects a nested payload that supplies the managed parent FK", async () => {
      const res = await post({
        number: 10,
        $nw_pkg_test_invoice_items: [{ product: "a", quantity: 1, invoice: "11111111-1111-1111-1111-111111111111" }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("NESTED_FOREIGN_KEY_NOT_ALLOWED");
    });
  });

  describe("Permissions", () => {
    it("rejects the whole request when child CREATE is denied", async () => {
      await context.permissions.set(roleId, invoiceItemsId, "CREATE", { effect: "DENY" });
      try {
        const res = await post({ number: 20, $nw_pkg_test_invoice_items: [{ product: "a", quantity: 1 }] });
        expect(res.statusCode).toBe(403);
        expect(res.json().errors[0].code).toBe("ACTION_DENIED");

        const { rows } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 20`);
        expect(rows).toHaveLength(0); // parent insert rolled back too
      } finally {
        await context.permissions.set(roleId, invoiceItemsId, "CREATE", {
          effect: "ALLOW",
          fields: [
            { field: "invoice", effect: "ALLOW" },
            { field: "product", effect: "ALLOW" },
            { field: "quantity", effect: "ALLOW" },
          ],
        });
      }
    });

    it("rejects a forbidden child column", async () => {
      await context.permissions.set(roleId, invoiceItemsId, "CREATE", {
        effect: "ALLOW",
        fields: [
          { field: "invoice", effect: "ALLOW" },
          { field: "product", effect: "ALLOW" },
          // "quantity" intentionally not granted
        ],
      });
      try {
        const res = await post({ number: 21, $nw_pkg_test_invoice_items: [{ product: "a", quantity: 1 }] });
        expect(res.statusCode).toBe(403);
        expect(res.json().errors[0].code).toBe("FIELD_PERMISSION_DENIED");

        const { rows } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 21`);
        expect(rows).toHaveLength(0);
      } finally {
        await context.permissions.set(roleId, invoiceItemsId, "CREATE", {
          effect: "ALLOW",
          fields: [
            { field: "invoice", effect: "ALLOW" },
            { field: "product", effect: "ALLOW" },
            { field: "quantity", effect: "ALLOW" },
          ],
        });
      }
    });
  });

  describe("PostgreSQL behavior and transactionality", () => {
    it("rolls back the parent and every child when a nested child violates a CHECK constraint", async () => {
      const res = await post({
        number: 30,
        $nw_pkg_test_invoice_items: [
          { product: "a", quantity: 1 },
          { product: "b", quantity: -1 }, // violates CHECK (quantity > 0)
        ],
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json().errors[0].code).toBe("CHECK_VIOLATION");

      const { rows: invoices } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 30`);
      expect(invoices).toHaveLength(0);
      const { rows: items } = await database.query(`SELECT * FROM public.nw_pkg_test_invoice_items WHERE product IN ('a','b')`);
      expect(items).toHaveLength(0);
    });

    it("rolls back everything when a grandchild fails", async () => {
      const res = await post({
        number: 31,
        $nw_pkg_test_invoice_items: [
          {
            product: "a",
            quantity: 1,
            $nw_pkg_test_invoice_item_taxes: [{ tax: "VAT" }], // missing required "rate"
          },
        ],
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json().errors[0].code).toBe("NOT_NULL_VIOLATION");

      const { rows: invoices } = await database.query(`SELECT * FROM public.nw_pkg_test_invoices WHERE number = 31`);
      expect(invoices).toHaveLength(0);
      const { rows: items } = await database.query(`SELECT * FROM public.nw_pkg_test_invoice_items WHERE product = 'a'`);
      expect(items).toHaveLength(0);
    });
  });

  describe("Deferred nested UPDATE", () => {
    it("rejects a $-relation payload on PATCH with UNSUPPORTED_NESTED_OPERATION", async () => {
      const created = await post({ number: 40, customer: "acme" });
      const id = created.json().data.id;

      const res = await app.inject({
        method: "PATCH",
        url: `/api/public/table/nw_pkg_test_invoices/${id}`,
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: { data: { customer: "updated", $nw_pkg_test_invoice_items: [{ product: "a", quantity: 1 }] } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("UNSUPPORTED_NESTED_OPERATION");
    });
  });
});
