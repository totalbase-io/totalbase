import { describe, expect, it } from "vitest";
import { countQueryNodes, filterFieldPaths } from "./complexity.js";
import { parseFilter, parseQuery } from "./parser.js";
import type { QueryAST } from "./ast.js";

function emptyAst(): QueryAST {
  return {
    fields: undefined,
    where: undefined,
    search: undefined,
    groupBy: undefined,
    having: undefined,
    aggregates: undefined,
    orderBy: undefined,
    limit: undefined,
    offset: undefined,
    count: false,
  };
}

describe("countQueryNodes", () => {
  it("counts zero for an empty query", () => {
    expect(countQueryNodes(emptyAst())).toBe(0);
  });

  // Security regression (Data_API.md §12): a search's words weren't counted - thousands of them, each matched in
  // every field, compiled to hundreds of thousands of comparisons before any limit refused the request.
  it("counts a search's words per field it looks in, and refuses more than ten words", () => {
    expect(countQueryNodes({ ...emptyAst(), search: "juan quilmes" })).toBe(2);
    expect(countQueryNodes({ ...emptyAst(), search: "a b c", searchFields: [["name"], ["city", "name"]] })).toBe(1 + 2 + 3 * 2);
    const limits = { maxFilterDepth: 10, maxRelationDepth: 3 };
    expect(() => parseQuery({ search: Array.from({ length: 11 }, () => "a").join(" ") }, limits)).toThrow(expect.objectContaining({ code: "QUERY_COMPLEXITY_LIMIT_EXCEEDED" }));
    expect(() => parseQuery({ search: Array.from({ length: 10 }, () => "a").join(" ") }, limits)).not.toThrow();
  });

  it("counts one per direct-column field, plus relation hops for a dotted path", () => {
    const ast = { ...emptyAst(), fields: [{ path: ["id"] }, { path: ["brand", "name"] }] };
    expect(countQueryNodes(ast)).toBe(1 + 2); // id=1, brand.name=1+1 hop
  });

  it("counts comparison and logical filter nodes recursively", () => {
    const ast: QueryAST = {
      ...emptyAst(),
      where: {
        type: "and",
        children: [
          { type: "comparison", path: ["price"], operator: "_gt", value: "0" },
          { type: "comparison", path: ["stock"], operator: "_gt", value: "0" },
        ],
      },
    };
    // 1 logical node + 2 comparison nodes = 3
    expect(countQueryNodes(ast)).toBe(3);
  });

  it("counts relation hops inside a filter's path", () => {
    const ast: QueryAST = {
      ...emptyAst(),
      where: { type: "comparison", path: ["brand", "category", "name"], operator: "_eq", value: "x" },
    };
    expect(countQueryNodes(ast)).toBe(1 + 2); // 1 node + 2 hops
  });

  it("counts group_by, order_by and aggregate nodes", () => {
    const ast: QueryAST = {
      ...emptyAst(),
      groupBy: [["category"]],
      orderBy: [{ path: ["price"], direction: "DESC" }],
      aggregates: [{ fn: "_count", path: "*", alias: "n" }],
    };
    expect(countQueryNodes(ast)).toBe(3);
  });
});

describe("filterFieldPaths", () => {
  it("lists every field a filter names - comparisons, relation paths and $ROW columns - once each", () => {
    const filter = parseFilter({ _or: [{ site: { _eq: "$USER.site" } }, { "user.password_hash": { _like: "x%" } }, { _not: { amount: { _gt: "$ROW.limit" } } }, { site: { _neq: "B" } }] }, { maxFilterDepth: 5, maxRelationDepth: 3 }, 0);
    expect(filterFieldPaths(filter)).toEqual(["site", "user.password_hash", "amount", "limit"]);
    expect(filterFieldPaths(undefined)).toEqual([]);
  });
});
