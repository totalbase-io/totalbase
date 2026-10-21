import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

const SUFFIX = uniqueSuffix();

/**
 * Route-level acceptance tests for Transactions
 * (Data_API.md §8).
 */
describe("Transactions", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;

  let invoicesId: string;
  let paymentsId: string;
  let roleId: string;
  let apiKeyPlain: string;
  let apiKeyId: string;
  let apiKeyUserId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.txn_pkg_test_payments CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.txn_pkg_test_invoices CASCADE`);
    await database.query(`
      CREATE TABLE public.txn_pkg_test_invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL DEFAULT 'pending'
      )
    `);
    await database.query(`
      CREATE TABLE public.txn_pkg_test_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice uuid NOT NULL REFERENCES public.txn_pkg_test_invoices (id),
        amount numeric NOT NULL
      )
    `);

    const resources = await database.query<{ name: string; id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES
         (to_regclass('public.txn_pkg_test_invoices')::oid, 'public', 'txn_pkg_test_invoices', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}'),
         (to_regclass('public.txn_pkg_test_payments')::oid, 'public', 'txn_pkg_test_payments', 'TABLE', 'ACTIVE', '{GET,POST,PATCH,DELETE}')
       RETURNING name, id`,
    );
    const byName = Object.fromEntries(resources.rows.map((r) => [r.name, r.id]));
    invoicesId = byName["txn_pkg_test_invoices"]!;
    paymentsId = byName["txn_pkg_test_payments"]!;

    const role = await context.roles.create(`txn-pkg-test-role-${SUFFIX}`, { apiAccess: true });
    roleId = role.id;

    await context.permissions.set(roleId, invoicesId, "READ", {
      effect: "ALLOW",
      fields: [
        { field: "id", effect: "ALLOW" },
        { field: "status", effect: "ALLOW" },
      ],
    });
    await context.permissions.set(roleId, invoicesId, "UPDATE", {
      effect: "ALLOW",
      fields: [{ field: "status", effect: "ALLOW" }],
    });
    await context.permissions.set(roleId, paymentsId, "READ", {
      effect: "ALLOW",
      fields: [
        { field: "id", effect: "ALLOW" },
        { field: "invoice", effect: "ALLOW" },
        { field: "amount", effect: "ALLOW" },
      ],
    });
    await context.permissions.set(roleId, paymentsId, "CREATE", {
      effect: "ALLOW",
      fields: [
        { field: "invoice", effect: "ALLOW" },
        { field: "amount", effect: "ALLOW" },
      ],
    });

    const created = await createTestApiToken(context, {
      name: `txn-pkg-test-key-${SUFFIX}`,
      roleId,
      email: `txn-pkg-test-key-${SUFFIX}@example.com`,
    });
    apiKeyPlain = created.plainKey;
    apiKeyId = created.tokenId;
    apiKeyUserId = created.userId;
  });

  afterEach(async () => {
    await database.query(`DELETE FROM public.txn_pkg_test_payments`);
    await database.query(`DELETE FROM public.txn_pkg_test_invoices`);
    await database.query(`DELETE FROM totalbase.roles_capabilities WHERE role = $1`, [roleId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [[invoicesId, paymentsId]]);
    await database.query(`DROP TABLE IF EXISTS public.txn_pkg_test_payments CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.txn_pkg_test_invoices CASCADE`);
    await app.close();
    await database.close();
  });

  function post(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/transactions",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: body,
    });
  }

  it("denies execution when the role has no transactions grant", async () => {
    const res = await post({ operations: [{ key: "p", operation: "insert", schema: "public", table: "txn_pkg_test_payments", data: { invoice: "00000000-0000-0000-0000-000000000000", amount: 1 } }] });
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("TRANSACTION_EXECUTION_DENIED");
  });

  it("commits multiple operations atomically and resolves backward references", async () => {
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");
    const invoice = await database.query<{ id: string }>(
      `INSERT INTO public.txn_pkg_test_invoices DEFAULT VALUES RETURNING id`,
    );
    const invoiceId = invoice.rows[0]!.id;

    const res = await post({
      operations: [
        { key: "invoice", operation: "update", schema: "public", table: "txn_pkg_test_invoices", id: invoiceId, data: { status: "paid" } },
        { key: "payment", operation: "insert", schema: "public", table: "txn_pkg_test_payments", data: { invoice: "$invoice.id", amount: 150000 } },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.invoice.status).toBe("paid");
    expect(body.payment.invoice).toBe(invoiceId);
    expect(Number(body.payment.amount)).toBe(150000);

    const payments = await database.query(`SELECT * FROM public.txn_pkg_test_payments WHERE invoice = $1`, [invoiceId]);
    expect(payments.rows).toHaveLength(1);
  });

  it("rolls back every operation when one fails (denied resource)", async () => {
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");
    const invoice = await database.query<{ id: string }>(
      `INSERT INTO public.txn_pkg_test_invoices DEFAULT VALUES RETURNING id`,
    );
    const invoiceId = invoice.rows[0]!.id;

    const res = await post({
      operations: [
        { key: "payment", operation: "insert", schema: "public", table: "txn_pkg_test_payments", data: { invoice: invoiceId, amount: 5 } },
        // DELETE was never granted for invoices -> this operation must fail
        // and roll back the payment insert above.
        { key: "invoice", operation: "delete", schema: "public", table: "txn_pkg_test_invoices", id: invoiceId },
      ],
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const payments = await database.query(`SELECT * FROM public.txn_pkg_test_payments`);
    expect(payments.rows).toHaveLength(0);
  });

  it("runs a nested CREATE inside the transaction - the tree and the later operations commit together, or nothing does", async () => {
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");
    await context.permissions.set(roleId, invoicesId, "CREATE", { effect: "ALLOW", fields: [{ field: "status", effect: "ALLOW" }] });
    try {
      const ok = await post({ operations: [
        { key: "inv", operation: "insert", schema: "public", table: "txn_pkg_test_invoices", data: { status: "draft", $txn_pkg_test_payments: [{ amount: 1 }, { amount: 2 }] } },
        { key: "done", operation: "update", schema: "public", table: "txn_pkg_test_invoices", id: "$inv.id", data: { status: "paid" } },
      ] });
      expect(ok.statusCode, ok.body).toBeLessThan(300);
      const result = ok.json().data;
      expect(result.inv.$txn_pkg_test_payments).toHaveLength(2);
      const { rows } = await database.query<{ status: string; n: number }>(
        `SELECT i.status, (SELECT count(*)::int FROM public.txn_pkg_test_payments p WHERE p.invoice = i.id) AS n FROM public.txn_pkg_test_invoices i WHERE i.id = $1`,
        [result.inv.id],
      );
      expect(rows[0]).toEqual({ status: "paid", n: 2 });

      // A child PostgreSQL refuses (amount is NOT NULL): the whole transaction rolls back.
      const before = (await database.query(`SELECT 1 FROM public.txn_pkg_test_invoices`)).rows.length;
      const bad = await post({ operations: [
        { key: "inv", operation: "insert", schema: "public", table: "txn_pkg_test_invoices", data: { status: "draft", $txn_pkg_test_payments: [{ amount: 1 }, { amount: null }] } },
      ] });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect((await database.query(`SELECT 1 FROM public.txn_pkg_test_invoices`)).rows.length).toBe(before);
    } finally {
      await context.permissions.delete(roleId, invoicesId, "CREATE");
    }
  });

  it("applies transactions.timeout_ms to each statement", async () => {
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");
    await context.settings.set("transactions.timeout_ms", 1);
    try {
      // 1 ms: PostgreSQL cancels the statement (QUERY_CANCELED) and the transaction rolls back.
      const res = await post({ operations: [{ key: "p", operation: "insert", schema: "public", table: "txn_pkg_test_payments", data: { invoice: "00000000-0000-0000-0000-000000000000", amount: 1 } }] });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await context.settings.reset("transactions.timeout_ms");
    }
  });

  it("rejects a transaction exceeding the configured operation limit", async () => {
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");
    await context.settings.set("transactions.max_operations", 1);
    try {
      const res = await post({
        operations: [
          { key: "a", operation: "insert", schema: "public", table: "txn_pkg_test_payments", data: { invoice: "00000000-0000-0000-0000-000000000000", amount: 1 } },
          { key: "b", operation: "insert", schema: "public", table: "txn_pkg_test_payments", data: { invoice: "00000000-0000-0000-0000-000000000000", amount: 1 } },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("TRANSACTION_LIMIT_EXCEEDED");
    } finally {
      await context.settings.set("transactions.max_operations", 20);
    }
  });
});
