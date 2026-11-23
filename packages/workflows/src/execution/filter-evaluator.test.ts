import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { parseFilter } from "@totalbase/query-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateFilter, matchPatterns } from "./filter-evaluator.js";

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

  it("never matches a pattern itself - PostgreSQL does (matchPatterns)", () => {
    const filter = parseFilter({ code: { _regex: "^A" } }, LIMITS, 0);
    expect(() => evaluateFilter(filter, { code: "A1" })).toThrow(/matchPatterns/);
  });
});

describe("matchPatterns() (integration)", () => {
  let database: Database;
  beforeAll(() => {
    database = new Database(loadDatabaseConfigFromEnv());
  });
  afterAll(async () => {
    await database.close();
  });

  const evaluate = async (raw: Record<string, unknown>, input: unknown) => {
    const filter = parseFilter(raw, LIMITS, 0);
    return evaluateFilter(filter, input, await matchPatterns(database, filter, input));
  };

  it("matches LIKE, ILIKE and POSIX regular expressions as the Data API does", async () => {
    expect(await evaluate({ name: { _like: "Ac%e" } }, { name: "Acme" })).toBe(true);
    expect(await evaluate({ name: { _like: "ac%" } }, { name: "Acme" })).toBe(false);
    expect(await evaluate({ name: { _ilike: "ac%" } }, { name: "Acme" })).toBe(true);
    expect(await evaluate({ code: { _regex: "^[0-9]{2}-[0-9]{8}-[0-9]$" } }, { code: "30-12345678-9" })).toBe(true);
    expect(await evaluate({ _and: [{ code: { _regex: "^X" } }, { n: { _gt: 1 } }] }, { code: "X1", n: 2 })).toBe(true);
    expect(await evaluate({ _or: [{ code: { _regex: "^X" } }, { name: { _like: "%z" } }] }, { code: "A", name: "b" })).toBe(false);
    // A missing field is the empty text, as before.
    expect(await evaluate({ name: { _like: "%" } }, {})).toBe(true);
  });

  // Security regression (SEC-31, D8): `_regex` ran in Node's one thread, and a pattern is a binding the trigger can
  // choose (`{{trigger.data.pattern}}`) - one built to backtrack held the whole server. PostgreSQL's is cancelled.
  it("answers a pattern built to backtrack at once instead of holding the server (security regression)", async () => {
    // In Node, /^(a+)+b$/ against 28 a's took about 12 s, all of them blocking every other request.
    const started = Date.now();
    expect(await evaluate({ text: { _regex: "^(a+)+b$" } }, { text: "a".repeat(5_000) })).toBe(false);
    expect(await evaluate({ text: { _like: "%a%a%a%a%a%a%a%a%b" } }, { text: "a".repeat(5_000) })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
