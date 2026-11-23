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

  // Security regression (Administration.md §11.6): what runs SQL the guard can't read (DO, CALL, EXECUTE), what runs
  // its statement (EXPLAIN ANALYZE, PREPARE ... AS), a MERGE that deletes, and text the lexer misread - a `$` inside
  // an identifier taken for a dollar quote, an E'' string's backslashed quote taken for its end - all passed as
  // destroying nothing.
  it("flags what it can't read or what runs a destructive statement, and lexes $ and E'' as PostgreSQL does", () => {
    expect(destructiveStatements("DO $$ BEGIN DELETE FROM t; END $$")).toEqual(["DO"]);
    expect(destructiveStatements("CALL purge_all()")).toEqual(["CALL"]);
    expect(destructiveStatements("PREPARE p AS DELETE FROM t; EXECUTE p")).toEqual(["DELETE FROM", "EXECUTE"]);
    expect(destructiveStatements("EXPLAIN ANALYZE DELETE FROM t")).toEqual(["DELETE FROM"]);
    expect(destructiveStatements("EXPLAIN (ANALYZE) TRUNCATE t")).toEqual(["TRUNCATE"]);
    expect(destructiveStatements("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE")).toEqual(["MERGE ... DELETE"]);
    expect(destructiveStatements("SELECT a$b$c FROM t; DROP TABLE t; SELECT $b$")).toEqual(["DROP"]);
    expect(destructiveStatements("SELECT E'it\\'s'; DROP TABLE t; SELECT 'x'")).toEqual(["DROP"]);
    // SEC-88: a COPY of a data-modifying query, and a rule, write too.
    expect(destructiveStatements("COPY (DELETE FROM t RETURNING 1) TO STDOUT")).toEqual(["COPY (...)"]);
    expect(destructiveStatements("CREATE OR REPLACE RULE r AS ON INSERT TO t DO ALSO DELETE FROM u")).toEqual(["CREATE RULE"]);
    expect(destructiveStatements("COPY (SELECT 1) TO STDOUT")).toEqual([]);
    expect(destructiveStatements("EXPLAIN DELETE FROM t")).toEqual([]);
    expect(destructiveStatements("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET n = s.n")).toEqual([]);
  });
});
