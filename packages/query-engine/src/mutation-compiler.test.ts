import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import type { PermissionDecision } from "@totalbase/permissions";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FilterNode } from "./ast.js";
import { compileDelete, compileInsert, compileUpdate, type ConflictUpdateAuthorization, type MutationCompileContext } from "./mutation-compiler.js";
import { SchemaContext, type ResolvedResource } from "./schema-context.js";

function allowAll(): PermissionDecision {
  return "ALLOW";
}

describe("mutation-compiler (integration)", () => {
  let database: Database;
  let root: ResolvedResource;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());

    await database.query(`DROP TABLE IF EXISTS public.mc_test_products CASCADE`);
    await database.query(`
      CREATE TABLE public.mc_test_products (
        id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sku      text NOT NULL UNIQUE,
        name     text NOT NULL,
        price    numeric NOT NULL,
        active   boolean NOT NULL DEFAULT true,
        location point
      )
    `);

    const { rows } = await database.query<{ oid: number }>(
      `SELECT 'public.mc_test_products'::regclass::oid::int AS oid`,
    );
    const schemaContext = new SchemaContext(database);
    root = await schemaContext.loadRoot("public", "mc_test_products", rows[0]!.oid);
  });

  afterEach(async () => {
    await database.query(`TRUNCATE public.mc_test_products`);
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.mc_test_products CASCADE`);
    await database.close();
  });

  function allowUpdate(overrides?: Partial<ConflictUpdateAuthorization>): ConflictUpdateAuthorization {
    return { fieldDecision: allowAll, rowFilter: undefined, payloadChecks: undefined, ...overrides };
  }

  function context(overrides?: Partial<MutationCompileContext>): MutationCompileContext {
    return {
      root,
      fieldDecision: allowAll,
      rowFilter: undefined,
      payloadChecks: undefined,
      resolveUserVariable: () => {
        throw new Error("no $USER in this test");
      },
      ...overrides,
    };
  }

  describe("compileInsert", () => {
    it("inserts a row and returns it", async () => {
      const compiled = await compileInsert(context(), { sku: "A1", name: "Widget", price: 10 });
      const { rows } = await database.query<{ sku: string; __authorized: boolean }>(compiled.sql, compiled.params);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sku).toBe("A1");
      expect(rows[0]?.__authorized).toBe(true);
    });

    it("serializes a { lng, lat } value into a real point column, read back parsed", async () => {
      const compiled = await compileInsert(context(), {
        sku: "A2",
        name: "Kiosk",
        price: 5,
        location: { lng: -58.38, lat: -34.6 },
      });
      const { rows } = await database.query(compiled.sql, compiled.params);
      expect(rows[0]).toMatchObject({ sku: "A2" });

      const { rows: readRows } = await database.query<{ location: { lng: number; lat: number } }>(
        `SELECT location FROM public.mc_test_products WHERE sku = 'A2'`,
      );
      expect(readRows[0]?.location).toEqual({ lng: -58.38, lat: -34.6 });
    });

    // An empty CREATE is PostgreSQL's DEFAULT VALUES - a row made only of the
    // table's defaults, still authorized like any other INSERT.
    describe("with no fields (DEFAULT VALUES)", () => {
      let defaultsRoot: ResolvedResource;

      beforeAll(async () => {
        await database.query(`DROP TABLE IF EXISTS public.mc_test_defaults`);
        await database.query(`
          CREATE TABLE public.mc_test_defaults (
            id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            status text NOT NULL DEFAULT 'DRAFT',
            opened date NOT NULL DEFAULT current_date
          )
        `);
        const { rows } = await database.query<{ oid: number }>(`SELECT 'public.mc_test_defaults'::regclass::oid::int AS oid`);
        defaultsRoot = await new SchemaContext(database).loadRoot("public", "mc_test_defaults", rows[0]!.oid);
      });

      afterAll(async () => {
        await database.query(`DROP TABLE IF EXISTS public.mc_test_defaults`);
      });

      it("inserts a row made only of the table's defaults", async () => {
        const compiled = await compileInsert(context({ root: defaultsRoot }), {});
        expect(compiled.sql).toContain("DEFAULT VALUES");
        const { rows } = await database.query<{ id: string; status: string; __authorized: boolean }>(compiled.sql, compiled.params);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "DRAFT", __authorized: true });
        expect(rows[0]?.id).toBeTruthy();
      });

      it("checks the row filter against the defaulted row", async () => {
        const rowFilter: FilterNode = { type: "comparison", path: ["status"], operator: "_eq", value: "OPEN" };
        const compiled = await compileInsert(context({ root: defaultsRoot, rowFilter }), {});
        const { rows } = await database.query<{ __authorized: boolean }>(compiled.sql, compiled.params);
        expect(rows[0]?.__authorized).toBe(false);
      });

      it("leaves a NOT NULL column without a default to PostgreSQL", async () => {
        const compiled = await compileInsert(context(), {});
        await expect(database.query(compiled.sql, compiled.params)).rejects.toMatchObject({ code: "NOT_NULL_VIOLATION" });
      });
    });

    it("rejects a field the caller cannot set", async () => {
      await expect(
        compileInsert(
          context({ fieldDecision: (f) => (f === "price" ? "DENY" : "ALLOW") }),
          { sku: "A1", name: "Widget", price: 10 },
        ),
      ).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
    });

    it("flags __authorized false when the new row fails the row filter", async () => {
      const rowFilter: FilterNode = { type: "comparison", path: ["active"], operator: "_eq", value: "true" };
      const compiled = await compileInsert(context({ rowFilter }), {
        sku: "A2",
        name: "Inactive",
        price: 5,
        active: false,
      });
      const { rows } = await database.query<{ __authorized: boolean }>(compiled.sql, compiled.params);
      expect(rows[0]?.__authorized).toBe(false);
      // The row is still physically inserted; the caller is expected to roll back.
      const { rows: check } = await database.query(`SELECT * FROM public.mc_test_products WHERE sku = 'A2'`);
      expect(check).toHaveLength(1);
    });

    it("flags each payload check in its own __payload_check_N column, evaluated against the real inserted row", async () => {
      const priceOverZero: FilterNode = { type: "comparison", path: ["price"], operator: "_gt", value: "0" };
      const nameNotEmpty: FilterNode = { type: "comparison", path: ["name"], operator: "_neq", value: "" };
      const compiled = await compileInsert(
        context({ payloadChecks: [{ rule: priceOverZero, label: "Price must be positive" }, { rule: nameNotEmpty, label: "Name is required" }] }),
        { sku: "A3", name: "Widget", price: 10 },
      );
      expect(compiled.payloadCheckColumns).toEqual([
        { column: "__payload_check_0", label: "Price must be positive" },
        { column: "__payload_check_1", label: "Name is required" },
      ]);
      const { rows } = await database.query<{ __payload_check_0: boolean; __payload_check_1: boolean }>(compiled.sql, compiled.params);
      expect(rows[0]?.__payload_check_0).toBe(true);
      expect(rows[0]?.__payload_check_1).toBe(true);
    });

    it("flags __payload_check_0 false (but still inserts, like __authorized) when a payload check fails", async () => {
      const priceOverZero: FilterNode = { type: "comparison", path: ["price"], operator: "_gt", value: "0" };
      const compiled = await compileInsert(
        context({ payloadChecks: [{ rule: priceOverZero, label: "Price must be positive" }] }),
        { sku: "A4", name: "Free sample", price: 0 },
      );
      const { rows } = await database.query<{ __payload_check_0: boolean }>(compiled.sql, compiled.params);
      expect(rows[0]?.__payload_check_0).toBe(false);
      const { rows: check } = await database.query(`SELECT * FROM public.mc_test_products WHERE sku = 'A4'`);
      expect(check).toHaveLength(1);
    });

    it("supports ON CONFLICT DO NOTHING", async () => {
      await compileInsert(context(), { sku: "DUP", name: "First", price: 1 }).then((c) =>
        database.query(c.sql, c.params),
      );
      const compiled = await compileInsert(
        context(),
        { sku: "DUP", name: "Second", price: 2 },
        { target: ["sku"], action: "NOTHING" },
      );
      const { rows } = await database.query(compiled.sql, compiled.params);
      expect(rows).toHaveLength(0);
      const { rows: check } = await database.query<{ name: string }>(
        `SELECT name FROM public.mc_test_products WHERE sku = 'DUP'`,
      );
      expect(check[0]?.name).toBe("First");
    });

    it("supports ON CONFLICT DO UPDATE with $INSERT.*", async () => {
      const first = await compileInsert(context(), { sku: "UP1", name: "Original", price: 10 });
      await database.query(first.sql, first.params);

      const compiled = await compileInsert(
        context({ conflictUpdate: allowUpdate() }),
        { sku: "UP1", name: "Updated", price: 20 },
        { target: ["sku"], action: "UPDATE", data: { name: "$INSERT.name", price: "$INSERT.price" } },
      );
      const { rows } = await database.query<{ name: string; price: string; __inserted: boolean }>(compiled.sql, compiled.params);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("Updated");
      expect(rows[0]?.price).toBe("20");
      expect(compiled.insertedColumn).toBe("__inserted");
      expect(rows[0]?.__inserted).toBe(false);
    });

    describe("ON CONFLICT DO UPDATE is authorized as an UPDATE on its update branch", () => {
      const upsert = (data: Record<string, unknown>) =>
        ({ target: ["sku"], action: "UPDATE" as const, data });

      it("fails closed without the UPDATE authorization", async () => {
        await expect(
          compileInsert(context(), { sku: "X", name: "X", price: 1 }, upsert({ name: "$INSERT.name" })),
        ).rejects.toMatchObject({ code: "ACTION_DENIED" });
      });

      it("requires UPDATE field ALLOW for every SET field, independently of CREATE's", async () => {
        const updateFields = (field: string): PermissionDecision => (field === "price" ? "DENY" : "ALLOW");
        await expect(
          compileInsert(
            context({ conflictUpdate: allowUpdate({ fieldDecision: updateFields }) }),
            { sku: "X", name: "X", price: 1 },
            upsert({ price: "$INSERT.price" }),
          ),
        ).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
      });

      it("rejects an empty on_conflict.data", async () => {
        await expect(
          compileInsert(context({ conflictUpdate: allowUpdate() }), { sku: "X", name: "X", price: 1 }, upsert({})),
        ).rejects.toMatchObject({ code: "INVALID_ON_CONFLICT" });
      });

      it("tells an inserted row from an updated one (xmax = 0)", async () => {
        const insert = await compileInsert(
          context({ conflictUpdate: allowUpdate() }),
          { sku: "BR1", name: "New", price: 1 },
          upsert({ name: "$INSERT.name" }),
        );
        const first = await database.query<{ __inserted: boolean }>(insert.sql, insert.params);
        expect(first.rows[0]?.__inserted).toBe(true);
        const again = await database.query<{ __inserted: boolean }>(insert.sql, insert.params);
        expect(again.rows[0]?.__inserted).toBe(false);
      });

      it("leaves an existing row outside the UPDATE row filter untouched and returns nothing", async () => {
        const seed = await compileInsert(context(), { sku: "RF1", name: "Locked", price: 10, active: false });
        await database.query(seed.sql, seed.params);
        const onlyActive: FilterNode = { type: "comparison", path: ["active"], operator: "_eq", value: "true" };
        const compiled = await compileInsert(
          context({ conflictUpdate: allowUpdate({ rowFilter: onlyActive }) }),
          { sku: "RF1", name: "Hijacked", price: 99 },
          upsert({ name: "$INSERT.name", price: "$INSERT.price" }),
        );
        expect(compiled.sql).toMatch(/DO UPDATE SET .* WHERE \(?t0\."active"/);
        const { rows } = await database.query(compiled.sql, compiled.params);
        expect(rows).toHaveLength(0);
        const { rows: check } = await database.query<{ name: string }>(`SELECT name FROM public.mc_test_products WHERE sku = 'RF1'`);
        expect(check[0]?.name).toBe("Locked");
      });

      it("evaluates the CREATE row filter/checks on an inserted row and the UPDATE ones on an updated row", async () => {
        const cheap: FilterNode = { type: "comparison", path: ["price"], operator: "_lt", value: "50" };
        const named: FilterNode = { type: "comparison", path: ["name"], operator: "_neq", value: "forbidden" };
        const ctx = context({
          rowFilter: cheap,
          payloadChecks: [{ rule: named, label: "create check" }],
          conflictUpdate: allowUpdate({ payloadChecks: [{ rule: cheap, label: "update check" }] }),
        });
        // Inserted at price 80: the CREATE filter (price < 50) fails, the UPDATE check is not applied.
        const inserted = await compileInsert(ctx, { sku: "PB1", name: "ok", price: 80 }, upsert({ price: "$INSERT.price" }));
        const first = await database.query<Record<string, unknown>>(inserted.sql, inserted.params);
        expect(first.rows[0]).toMatchObject({ __inserted: true, __authorized: false, __payload_check_0: true, __payload_check_1: true });
        // Updated to price 80: no UPDATE row filter, the UPDATE check (price < 50) fails, the CREATE check is not applied.
        const updated = await compileInsert(ctx, { sku: "PB1", name: "forbidden", price: 80 }, upsert({ price: "$INSERT.price" }));
        const second = await database.query<Record<string, unknown>>(updated.sql, updated.params);
        expect(second.rows[0]).toMatchObject({ __inserted: false, __authorized: true, __payload_check_0: true, __payload_check_1: false });
        expect(updated.payloadCheckColumns.map((c) => c.label)).toEqual(["create check", "update check"]);
      });

      it("returns the updated row's old values for the requested fields, none for an inserted row", async () => {
        const seed = await compileInsert(context(), { sku: "OV1", name: "Before", price: 10 });
        await database.query(seed.sql, seed.params);
        const updated = await compileInsert(
          context({ conflictUpdate: allowUpdate() }),
          { sku: "OV1", name: "After", price: 10 },
          upsert({ name: "$INSERT.name" }),
          ["name", "price"],
        );
        expect(updated.oldValueColumns).toEqual([{ column: "__old_0", field: "name" }, { column: "__old_1", field: "price" }]);
        const { rows } = await database.query<Record<string, unknown>>(updated.sql, updated.params);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: "After", __inserted: false, __old_0: "Before", __old_1: "10" });

        const inserted = await compileInsert(
          context({ conflictUpdate: allowUpdate() }),
          { sku: "OV2", name: "Fresh", price: 1 },
          upsert({ name: "$INSERT.name" }),
          ["name"],
        );
        const { rows: insertedRows } = await database.query<Record<string, unknown>>(inserted.sql, inserted.params);
        expect(insertedRows[0]).toMatchObject({ name: "Fresh", __inserted: true, __old_0: null });
      });

      it("captures no old values when the conflict target is not in data", async () => {
        const compiled = await compileInsert(
          context({ conflictUpdate: allowUpdate() }),
          { sku: "NK1", name: "No key", price: 1 },
          { target: ["id"], action: "UPDATE", data: { name: "$INSERT.name" } },
          ["name"],
        );
        expect(compiled.oldValueColumns).toEqual([]);
        const { rows } = await database.query<Record<string, unknown>>(compiled.sql, compiled.params);
        expect(rows[0]).toMatchObject({ __inserted: true });
      });
    });

    it("rejects an on_conflict target that is not a real PK/UNIQUE", async () => {
      await expect(
        compileInsert(context(), { sku: "X", name: "X", price: 1 }, { target: ["name"], action: "NOTHING" }),
      ).rejects.toMatchObject({ code: "INVALID_ON_CONFLICT" });
    });
  });

  describe("compileUpdate", () => {
    async function seed() {
      const c = await compileInsert(context(), { sku: "U1", name: "Before", price: 10, active: true });
      await database.query(c.sql, c.params);
    }

    it("updates matching rows and returns the new values", async () => {
      await seed();
      const where: FilterNode = { type: "comparison", path: ["sku"], operator: "_eq", value: "U1" };
      const compiled = await compileUpdate(context(), { name: "After" }, where);
      const { rows } = await database.query<{ name: string; __authorized: boolean }>(compiled.sql, compiled.params);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("After");
      expect(rows[0]?.__authorized).toBe(true);
    });

    it("re-evaluates a payload check against the NEW (updated) row, not the old one", async () => {
      await seed(); // price: 10
      const where: FilterNode = { type: "comparison", path: ["sku"], operator: "_eq", value: "U1" };
      const priceOverZero: FilterNode = { type: "comparison", path: ["price"], operator: "_gt", value: "0" };
      const compiled = await compileUpdate(
        context({ payloadChecks: [{ rule: priceOverZero, label: "Price must be positive" }] }),
        { price: 0 },
        where,
      );
      const { rows } = await database.query<{ __payload_check_0: boolean }>(compiled.sql, compiled.params);
      expect(rows[0]?.__payload_check_0).toBe(false);
    });

    it("only touches rows satisfying the OLD row filter", async () => {
      await seed();
      const c2 = await compileInsert(context(), { sku: "U2", name: "Other", price: 5, active: false });
      await database.query(c2.sql, c2.params);

      const rowFilter: FilterNode = { type: "comparison", path: ["active"], operator: "_eq", value: "true" };
      const compiled = await compileUpdate(context({ rowFilter }), { name: "Changed" }, undefined);
      const { rows } = await database.query<{ sku: string }>(compiled.sql, compiled.params);
      expect(rows.map((r) => r.sku)).toEqual(["U1"]);
    });

    it("flags __authorized false when the update moves a row out of the row filter (NEW check)", async () => {
      await seed();
      const rowFilter: FilterNode = { type: "comparison", path: ["active"], operator: "_eq", value: "true" };
      const compiled = await compileUpdate(context({ rowFilter }), { active: false }, undefined);
      const { rows } = await database.query<{ __authorized: boolean }>(compiled.sql, compiled.params);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.__authorized).toBe(false);
    });

    describe("old values (an UPDATE's audit and outbox event)", () => {
      const whereU1: FilterNode = { type: "comparison", path: ["sku"], operator: "_eq", value: "U1" };

      it("keeps the plain UPDATE when no old-value field is asked for", async () => {
        const plain = await compileUpdate(context(), { name: "After" }, whereU1);
        const empty = await compileUpdate(context(), { name: "After" }, whereU1, []);
        expect(empty.sql).toBe(plain.sql);
        expect(plain.sql).not.toContain("FOR UPDATE");
        expect(plain.oldValueColumns).toEqual([]);
      });

      it("returns each asked field's value before the UPDATE as __old_N, in the same statement", async () => {
        await seed(); // name Before, price 10
        const compiled = await compileUpdate(context(), { name: "After" }, whereU1, ["name", "price", "dropped_column"]);
        expect(compiled.oldValueColumns).toEqual([
          { column: "__old_0", field: "name" },
          { column: "__old_1", field: "price" },
        ]);
        const { rows } = await database.query<Record<string, unknown>>(compiled.sql, compiled.params);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: "After", price: "10", __old_0: "Before", __old_1: "10", __authorized: true });
      });

      it("still applies the OLD row filter and re-checks NEW, with old values", async () => {
        await seed();
        const c2 = await compileInsert(context(), { sku: "U2", name: "Other", price: 5, active: false });
        await database.query(c2.sql, c2.params);
        const rowFilter: FilterNode = { type: "comparison", path: ["active"], operator: "_eq", value: "true" };
        const compiled = await compileUpdate(context({ rowFilter }), { active: false }, undefined, ["active"]);
        const { rows } = await database.query<Record<string, unknown>>(compiled.sql, compiled.params);
        expect(rows.map((r) => r["sku"])).toEqual(["U1"]);
        expect(rows[0]).toMatchObject({ active: false, __old_0: true, __authorized: false });
        const { rows: untouched } = await database.query<{ name: string }>(
          `SELECT name FROM public.mc_test_products WHERE sku = 'U2'`,
        );
        expect(untouched[0]?.name).toBe("Other");
      });

      it("reads the old values a concurrent writer committed while this UPDATE waited for the row", async () => {
        await seed(); // price 10
        let releaseFirst!: () => void;
        const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let firstLocked!: () => void;
        const locked = new Promise<void>((resolve) => { firstLocked = resolve; });

        const first = database.transaction(async (client) => {
          await client.query(`UPDATE public.mc_test_products SET price = 20 WHERE sku = 'U1'`);
          firstLocked();
          await firstHolds;
        });
        await locked;

        const compiled = await compileUpdate(context(), { name: "After" }, whereU1, ["price", "name"]);
        const second = database.query<Record<string, unknown>>(compiled.sql, compiled.params);
        // Wait until the second statement is actually blocked on the first's row lock.
        for (let attempt = 0; ; attempt++) {
          const { rows: waiting } = await database.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE '%old_rows%mc_test_products%'`,
          );
          if (waiting[0]!.count > 0) break;
          if (attempt > 100) throw new Error("the UPDATE never waited for the row lock");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        releaseFirst();
        await first;
        const { rows } = await second;

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: "After", price: "20", __old_0: "20", __old_1: "Before" });
      });
    });
  });

  describe("compileDelete", () => {
    async function seed() {
      const c1 = await compileInsert(context(), { sku: "D1", name: "A", price: 1, active: true });
      const c2 = await compileInsert(context(), { sku: "D2", name: "B", price: 2, active: false });
      await database.query(c1.sql, c1.params);
      await database.query(c2.sql, c2.params);
    }

    it("deletes matching rows and returns them", async () => {
      await seed();
      const where: FilterNode = { type: "comparison", path: ["sku"], operator: "_eq", value: "D1" };
      const compiled = await compileDelete(context(), where);
      const { rows } = await database.query<{ sku: string }>(compiled.sql, compiled.params);
      expect(rows.map((r) => r.sku)).toEqual(["D1"]);

      const { rows: remaining } = await database.query(`SELECT sku FROM public.mc_test_products`);
      expect(remaining).toHaveLength(1);
    });

    it("only deletes rows satisfying the permission row filter", async () => {
      await seed();
      const rowFilter: FilterNode = { type: "comparison", path: ["active"], operator: "_eq", value: "true" };
      const compiled = await compileDelete(context({ rowFilter }), undefined);
      const { rows } = await database.query<{ sku: string }>(compiled.sql, compiled.params);
      expect(rows.map((r) => r.sku)).toEqual(["D1"]);

      const { rows: remaining } = await database.query<{ sku: string }>(
        `SELECT sku FROM public.mc_test_products ORDER BY sku`,
      );
      expect(remaining.map((r) => r.sku)).toEqual(["D2"]);
    });
  });
});
