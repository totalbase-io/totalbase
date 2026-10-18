import { describe, expect, it } from "vitest";
import { checkConstraintValues } from "./check-values.js";

// As pg_get_constraintdef renders them (PostgreSQL 15-18).
describe("checkConstraintValues", () => {
  it("reads an IN list on a text column", () => {
    expect(checkConstraintValues("a", ["CHECK ((a = ANY (ARRAY['OPEN'::text, 'it''s'::text])))"])).toEqual(["OPEN", "it's"]);
  });

  it("reads a varchar column's, its name quoted", () => {
    const expression = `CHECK ((("B b")::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))`;
    expect(checkConstraintValues("B b", [expression])).toEqual(["x", "y"]);
  });

  it("takes the column's own CHECK, not another column's", () => {
    const expressions = ["CHECK ((other = ANY (ARRAY['x'::text])))", "CHECK ((a = ANY (ARRAY['y'::text])))"];
    expect(checkConstraintValues("a", expressions)).toEqual(["y"]);
    expect(checkConstraintValues("b", expressions)).toBeNull();
  });

  it("reads a numeric column's - each number as PostgreSQL wrote it (T61)", () => {
    expect(checkConstraintValues("iva", ["CHECK ((iva = ANY (ARRAY[(0)::numeric, 10.5, (21)::numeric, (27)::numeric])))"])).toEqual(["0", "10.5", "21", "27"]);
    expect(checkConstraintValues("n", ["CHECK ((n = ANY (ARRAY[30, 60, '-1'::integer])))"])).toEqual(["30", "60", "-1"]);
  });

  it("leaves anything that isn't a plain list", () => {
    expect(checkConstraintValues("c", ["CHECK ((c = 'only'::text))"])).toBeNull();
    expect(checkConstraintValues("d", ["CHECK (((d = ANY (ARRAY['p'::text, 'q'::text])) OR (d IS NULL)))"])).toBeNull();
    expect(checkConstraintValues("e", ["CHECK ((e = ANY ('{r,s}'::text[])))"])).toBeNull();
    expect(checkConstraintValues("f", ["CHECK ((lower(f) = ANY (ARRAY['x'::text])))"])).toBeNull();
  });
});
