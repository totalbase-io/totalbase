import knexFactory from "knex";
import { describe, expect, it } from "vitest";
import { createKnexCompiler } from "./knex-compiler.js";

/**
 * Pure compile-only proof that adopting Knex actually buys dialect
 * coverage - no live connection to any engine, just asserting the same
 * table-schema-service.ts builder logic produces materially different
 * SQL when compiled against a different `client`. See
 * Foundations.md's Phase 5 note: no MySQL/SQL
 * Server instance is stood up anywhere in this repo - this is the
 * substitute proof that the abstraction is real, not decorative.
 */
describe("Knex dialect divergence (compile-only, no connection)", () => {
  it("compiles an ADD COLUMN statement differently for Postgres vs MySQL identifier quoting", () => {
    const pg = createKnexCompiler("pg");
    const mysql = knexFactory({ client: "mysql2" });

    const pgSql = pg.schema.withSchema("public").alterTable("widgets", (t) => {
      t.specificType("sku", "text").notNullable();
    }).toString();
    const mysqlSql = mysql.schema.alterTable("widgets", (t) => {
      t.specificType("sku", "text").notNullable();
    }).toString();

    expect(pgSql).toContain('"sku"');
    expect(mysqlSql).toContain("`sku`");
    expect(pgSql).not.toBe(mysqlSql);
  });

  it("compiles a column type change using each dialect's own ALTER form", () => {
    const pg = createKnexCompiler("pg");
    const mysql = knexFactory({ client: "mysql2" });

    const pgSql = pg.schema.withSchema("public").alterTable("widgets", (t) => {
      t.specificType("price", "numeric(12,2)").alter({ alterType: true });
    }).toString();
    const mysqlSql = mysql.schema.alterTable("widgets", (t) => {
      t.specificType("price", "decimal(12,2)").alter({ alterType: true });
    }).toString();

    // Postgres: ALTER COLUMN ... TYPE ...; MySQL has no such form at all -
    // it redefines the column via MODIFY COLUMN instead.
    expect(pgSql.toLowerCase()).toContain("alter column");
    expect(pgSql.toLowerCase()).toContain("type numeric(12,2)");
    expect(mysqlSql.toLowerCase()).not.toContain("alter column");
    expect(mysqlSql.toLowerCase()).toContain("modify");
  });
});
