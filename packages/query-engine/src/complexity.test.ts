import { describe, expect, it } from "vitest";
import { countQueryNodes } from "./complexity.js";
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
