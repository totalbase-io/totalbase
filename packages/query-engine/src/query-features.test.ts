import { describe, expect, it } from "vitest";
import { parseFilter, parseQuery } from "./parser.js";
import { assertFilterFeatures, assertQueryFeatures, type QueryFeatures } from "./query-features.js";

const LIMITS = { maxFilterDepth: 10, maxRelationDepth: 3 };
const ALL: QueryFeatures = { count: true, regex: true, contains: true, having: true };

describe("assertQueryFeatures", () => {
  it("allows everything when every feature is on", () => {
    const ast = parseQuery(
      { count: "true", where: { name: { _regex: "^a" }, tags: { _overlap: "{x}" } }, group_by: "name", having: { name: { _eq: "a" } } },
      LIMITS,
    );
    expect(() => assertQueryFeatures(ast, ALL)).not.toThrow();
  });

  it("rejects each switched-off feature with QUERY_FEATURE_DISABLED", () => {
    const cases: Array<[Record<string, unknown>, Partial<QueryFeatures>]> = [
      [{ count: "true" }, { count: false }],
      [{ group_by: "name", having: { name: { _eq: "a" } } }, { having: false }],
      [{ where: { _or: [{ id: { _eq: "1" } }, { name: { _regex: "^a" } }] } }, { regex: false }],
      [{ where: { tags: { _contains: "{x}" } } }, { contains: false }],
      [{ where: { tags: { _contained_by: "{x}" } } }, { contains: false }],
      [{ where: { tags: { _overlap: "{x}" } } }, { contains: false }],
    ];
    for (const [raw, off] of cases) {
      expect(() => assertQueryFeatures(parseQuery(raw, LIMITS), { ...ALL, ...off }), JSON.stringify(raw)).toThrow(
        expect.objectContaining({ code: "QUERY_FEATURE_DISABLED" }),
      );
    }
  });

  it("checks a bare filter too - a bulk write's where", () => {
    const where = parseFilter({ _not: { name: { _regex: "x" } } }, LIMITS, 0);
    expect(() => assertFilterFeatures(where, { ...ALL, regex: false })).toThrow(expect.objectContaining({ code: "QUERY_FEATURE_DISABLED" }));
    expect(() => assertFilterFeatures(undefined, { ...ALL, regex: false })).not.toThrow();
  });
});
