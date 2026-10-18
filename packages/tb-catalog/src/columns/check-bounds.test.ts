import { describe, expect, it } from "vitest";
import { checkConstraintBounds, checkConstraintDateBounds, holdsBound } from "./check-bounds.js";

const check = (expression: string, message: string | null = null) => [{ expression, message }];

// As pg_get_constraintdef renders them (PostgreSQL 15-18).
describe("checkConstraintBounds", () => {
  it("reads a number's bounds, ANDed, cast or not", () => {
    expect(checkConstraintBounds("a", check("CHECK (((a >= (0)::numeric) AND (a <= 1000.5)))", "Entre 0 y 1000,5"))).toEqual([
      { kind: "value", op: ">=", value: 0, message: "Entre 0 y 1000,5" },
      { kind: "value", op: "<=", value: 1000.5, message: "Entre 0 y 1000,5" },
    ]);
    expect(checkConstraintBounds("b", check("CHECK ((b > '-5'::integer))"))).toEqual([{ kind: "value", op: ">", value: -5, message: null }]);
    expect(checkConstraintBounds("g", check("CHECK ((g >= ('-2.5'::numeric)::double precision))"))).toEqual([{ kind: "value", op: ">=", value: -2.5, message: null }]);
  });

  it("turns a bound written the other way around", () => {
    expect(checkConstraintBounds("d", check("CHECK (((0)::numeric < d))"))).toEqual([{ kind: "value", op: ">", value: 0, message: null }]);
  });

  it("reads a text's length bounds", () => {
    expect(checkConstraintBounds("c", check("CHECK (((length(c) >= 3) AND (length(c) <= 10)))"))).toEqual([
      { kind: "length", op: ">=", value: 3, message: null },
      { kind: "length", op: "<=", value: 10, message: null },
    ]);
    expect(checkConstraintBounds("e", check("CHECK ((char_length(e) <= 20))"))).toEqual([{ kind: "length", op: "<=", value: 20, message: null }]);
  });

  it("takes only its own column, and none from an OR", () => {
    expect(checkConstraintBounds("x", check("CHECK ((a >= 0))"))).toEqual([]);
    expect(checkConstraintBounds("f", check("CHECK (((f >= 1) OR (f IS NULL)))"))).toEqual([]);
    expect(checkConstraintBounds("q", check(`CHECK (("Precio total" >= (0)::numeric))`))).toEqual([]);
    expect(checkConstraintBounds("Precio total", check(`CHECK (("Precio total" >= (0)::numeric))`))).toEqual([{ kind: "value", op: ">=", value: 0, message: null }]);
  });

  it("keeps a bound that holds alongside IS NOT NULL", () => {
    expect(checkConstraintBounds("n", check("CHECK (((n IS NOT NULL) AND (n >= 1)))"))).toEqual([{ kind: "value", op: ">=", value: 1, message: null }]);
  });
});

describe("holdsBound", () => {
  it("compares inclusively or not, as the CHECK says", () => {
    expect(holdsBound({ kind: "value", op: ">=", value: 0, message: null }, 0)).toBe(true);
    expect(holdsBound({ kind: "value", op: ">", value: 0, message: null }, 0)).toBe(false);
    expect(holdsBound({ kind: "length", op: "<=", value: 3, message: null }, 4)).toBe(false);
  });
});

describe("checkConstraintDateBounds()", () => {
  const check = (expression: string, message: string | null = null) => ({ expression, message });
  it("reads a day or today on either side, through casts, as PostgreSQL renders them", () => {
    expect(checkConstraintDateBounds("nacimiento", [check("CHECK ((nacimiento <= CURRENT_DATE))", "No puede ser futura")])).toEqual([{ op: "<=", value: "today", message: "No puede ser futura" }]);
    expect(checkConstraintDateBounds("emitida", [check("CHECK (((emitida >= '2020-01-01'::date) AND (emitida <= (now())::date)))")])).toEqual([
      { op: ">=", value: "2020-01-01", message: null },
      { op: "<=", value: "today", message: null },
    ]);
    expect(checkConstraintDateBounds("creado", [check("CHECK (('2024-03-01'::date < creado))")])).toEqual([{ op: ">", value: "2024-03-01", message: null }]);
  });
  it("leaves a comparison between columns, another column's, and anything under an OR", () => {
    expect(checkConstraintDateBounds("vence", [check("CHECK ((vence > emitida))")])).toEqual([]);
    expect(checkConstraintDateBounds("vence", [check("CHECK ((otra <= CURRENT_DATE))")])).toEqual([]);
    expect(checkConstraintDateBounds("vence", [check("CHECK (((vence IS NULL) OR (vence <= CURRENT_DATE)))")])).toEqual([]);
  });
});
