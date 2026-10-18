import { describe, expect, it } from "vitest";
import { buildCheckExpression } from "./check-expression.js";

const COLUMNS = [
  { name: "price", dataType: "numeric(12,2)" },
  { name: "status", dataType: "text" },
  { name: "active", dataType: "boolean" },
  { name: "tags", dataType: "text[]" },
  { name: 'odd"name', dataType: "text" },
];

describe("buildCheckExpression()", () => {
  it("writes each condition parenthesized, AND-joined, with the column's kind of literal", () => {
    expect(buildCheckExpression([{ field: "price", operator: "_gt", value: "0" }], COLUMNS)).toBe('("price" > 0)');
    expect(
      buildCheckExpression(
        [
          { field: "price", operator: "_gte", value: "1.5" },
          { field: "status", operator: "_in", value: "draft, sent" },
          { field: "active", operator: "_eq", value: "false" },
        ],
        COLUMNS,
      ),
    ).toBe(`("price" >= 1.5) AND ("status" IN ('draft', 'sent')) AND ("active" = false)`);
  });

  it("handles the unary, the pair and the array operators", () => {
    expect(buildCheckExpression([{ field: "status", operator: "_nnull" }], COLUMNS)).toBe('("status" IS NOT NULL)');
    expect(buildCheckExpression([{ field: "price", operator: "_between", value: ["1", "10"] }], COLUMNS)).toBe('("price" BETWEEN 1 AND 10)');
    expect(buildCheckExpression([{ field: "tags", operator: "_contains", value: "{a}" }], COLUMNS)).toBe(`("tags" @> '{a}')`);
  });

  it("quotes identifiers and literals - a value never escapes its string", () => {
    expect(buildCheckExpression([{ field: 'odd"name', operator: "_eq", value: "o'brien" }], COLUMNS)).toBe(`("odd""name" = 'o''brien')`);
    expect(buildCheckExpression([{ field: "status", operator: "_eq", value: "x'); DROP TABLE t; --" }], COLUMNS)).toBe(`("status" = 'x''); DROP TABLE t; --')`);
    // A non-numeric value on a number column is still a quoted string, for PostgreSQL to refuse - never bare text in the DDL.
    expect(buildCheckExpression([{ field: "price", operator: "_eq", value: "1; DROP" }], COLUMNS)).toBe(`("price" = '1; DROP')`);
  });

  it("refuses a column the table hasn't, an unknown operator and a missing value", () => {
    expect(() => buildCheckExpression([{ field: "nope", operator: "_eq", value: "1" }], COLUMNS)).toThrow(/Not a column/);
    expect(() => buildCheckExpression([{ field: "price", operator: "_bogus" as never, value: "1" }], COLUMNS)).toThrow(/Unknown operator/);
    expect(() => buildCheckExpression([{ field: "price", operator: "_eq" }], COLUMNS)).toThrow(/needs a value/);
    expect(() => buildCheckExpression([{ field: "price", operator: "_between", value: "1" }], COLUMNS)).toThrow(/pair/);
    expect(buildCheckExpression([], COLUMNS)).toBe("");
  });
});
