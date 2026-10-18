import { describe, expect, it } from "vitest";
import { pivotGroupingSets, pivotSql } from "./pivot-query.js";

const spec = { rows: ["branch", "sex"], columns: ["month"], values: [{ column: "total", aggregate: "avg" as const }], subtotals: true, rowTotals: true, columnTotals: true };

describe("a pivot's aggregation (D17)", () => {
  it("is ROLLUP(rows) x ROLLUP(columns) with everything on - fewer sets as totals turn off", () => {
    expect(pivotGroupingSets(spec)).toEqual([
      ["branch", "sex", "month"], ["branch", "sex"],
      ["branch", "month"], ["branch"],
      ["month"], [],
    ]);
    expect(pivotGroupingSets({ ...spec, subtotals: false, rowTotals: false, columnTotals: false })).toEqual([["branch", "sex", "month"]]);
    expect(pivotGroupingSets({ ...spec, columns: [] })).toEqual([["branch", "sex"], ["branch"], []]);
  });

  it("wraps the query, its identifiers quoted, totals first", () => {
    const sql = pivotSql("SELECT * FROM t", spec, 1001);
    expect(sql).toContain('avg("total") AS "total"');
    expect(sql).toContain('GROUPING("branch", "sex", "month") AS "__grouping"');
    expect(sql).toContain('ORDER BY ("__grouping" >> 1) DESC, "branch" NULLS LAST, "sex" NULLS LAST, "__grouping" DESC, "month" NULLS LAST');
    expect(sql).toMatch(/LIMIT 1001$/);
  });

  it("orders each level by its own total of sortBy's value before the cap (DB36)", () => {
    const sql = pivotSql("SELECT * FROM t", { ...spec, sortBy: { value: "total", direction: "DESC" } }, 1001);
    // branch's key: the (branch) set - sex and month totaled (bits 2 + 1); sex's: the (branch, sex) set (bit 1).
    expect(sql).toContain('max(CASE WHEN "__grouping" = 3 THEN "total" END) OVER (PARTITION BY "branch") DESC NULLS LAST, "branch" NULLS LAST');
    expect(sql).toContain('max(CASE WHEN "__grouping" = 1 THEN "total" END) OVER (PARTITION BY "branch", "sex") DESC NULLS LAST, "sex" NULLS LAST');
    // A value that isn't one of the pivot's is ignored, as on the screen.
    expect(pivotSql("SELECT * FROM t", { ...spec, sortBy: { value: "nope", direction: "DESC" } }, 10)).not.toContain("OVER");
  });
});
