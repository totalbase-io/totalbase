import { describe, expect, it } from "vitest";
import { destructiveStatements } from "./sql-guard.js";

describe("destructiveStatements", () => {
  it("finds statements that destroy", () => {
    expect(destructiveStatements("DROP VIEW v; select 1; truncate t; delete from t where id = 1; REVOKE ALL ON t FROM r")).toEqual(["DROP", "TRUNCATE", "DELETE FROM", "REVOKE"]);
    expect(destructiveStatements("ALTER TABLE t DROP COLUMN c")).toEqual(["ALTER ... DROP"]);
    expect(destructiveStatements("WITH gone AS (DELETE FROM t RETURNING id) SELECT count(*) FROM gone")).toEqual(["DELETE FROM"]);
  });

  it("ignores function bodies, triggers, comments and literals", () => {
    const fn = `CREATE FUNCTION purge() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN DELETE FROM logs WHERE old; DROP TABLE IF EXISTS tmp; RETURN NEW; END $body$;
      CREATE TRIGGER t BEFORE INSERT OR UPDATE OR DELETE ON items FOR EACH ROW EXECUTE FUNCTION purge();
      -- DROP TABLE items;
      /* TRUNCATE items; */
      INSERT INTO notes (body) VALUES ('please delete from the list; drop it');
      CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`;
    expect(destructiveStatements(fn)).toEqual([]);
  });

  it("doesn't count dropping a column's default or NOT NULL", () => {
    expect(destructiveStatements("ALTER TABLE t ALTER COLUMN c DROP NOT NULL; ALTER TABLE t ALTER COLUMN d DROP DEFAULT")).toEqual([]);
  });
});
