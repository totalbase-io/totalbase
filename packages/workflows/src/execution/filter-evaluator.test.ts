import { parseFilter } from "@totalbase/query-engine";
import { describe, expect, it } from "vitest";
import { evaluateFilter } from "./filter-evaluator.js";

const LIMITS = { maxFilterDepth: 10, maxRelationDepth: 3 };
const DAY = 86_400_000;

describe("evaluateFilter()", () => {
  it("compares a field against another field of the same object with $ROW.<field> (T68)", () => {
    const below = parseFilter({ stock: { _lt: "$ROW.stock_minimo" } }, LIMITS, 0);
    expect(evaluateFilter(below, { stock: 2, stock_minimo: 5 })).toBe(true);
    expect(evaluateFilter(below, { stock: 9, stock_minimo: 5 })).toBe(false);
  });

  it("reads $INTERVAL.* as CURRENT_TIMESTAMP minus the interval, like the SQL compiler", () => {
    // Regression: it used to add the interval, so "$INTERVAL.7d" meant 7 days ahead.
    const filter = parseFilter({ created_at: { _gte: "$INTERVAL.7d" } }, LIMITS, 0);
    expect(evaluateFilter(filter, { created_at: new Date(Date.now() - 2 * DAY) })).toBe(true);
    expect(evaluateFilter(filter, { created_at: new Date(Date.now() - 10 * DAY) })).toBe(false);
  });

  it("rejects $PERIOD.* - its bounds come from PostgreSQL", () => {
    const filter = parseFilter({ created_at: { _gte: "$PERIOD.this_month.from" } }, LIMITS, 0);
    expect(() => evaluateFilter(filter, { created_at: new Date() })).toThrow(/\$PERIOD/);
  });
});
