import { describe, expect, it } from "vitest";
import { parseFilter, parseQuery } from "./parser.js";
import { assertFilterComplexity } from "./complexity.js";

const limits = { maxFilterDepth: 10, maxRelationDepth: 3 };

describe("parseQuery: fields", () => {
  it("parses a plain comma list with no aliases", () => {
    const ast = parseQuery({ fields: "id,name,brand.name" }, limits);
    expect(ast.fields).toEqual([{ path: ["id"] }, { path: ["name"] }, { path: ["brand", "name"] }]);
  });

  it("parses the bracket alias form", () => {
    const ast = parseQuery({ fields: { first_name: "Name", "brand.name": "Brand" } }, limits);
    expect(ast.fields).toEqual([
      { path: ["first_name"], alias: "Name" },
      { path: ["brand", "name"], alias: "Brand" },
    ]);
  });

  it("rejects duplicate aliases", () => {
    expect(() => parseQuery({ fields: { a: "X", b: "X" } }, limits)).toThrow();
  });

  it("rejects relation paths deeper than max_relation_depth", () => {
    expect(() => parseQuery({ fields: "a.b.c.d.e" }, { ...limits, maxRelationDepth: 2 })).toThrow();
  });
});

describe("parseQuery: where", () => {
  it("parses a simple comparison", () => {
    const ast = parseQuery({ where: { price: { _gt: "100" } } }, limits);
    expect(ast.where).toEqual({
      type: "comparison",
      path: ["price"],
      operator: "_gt",
      value: "100",
    });
  });

  it("combines sibling fields with AND", () => {
    const ast = parseQuery({ where: { price: { _gt: "100" }, active: { _eq: "true" } } }, limits);
    expect(ast.where?.type).toBe("and");
  });

  it("parses dotted relation paths in where", () => {
    const ast = parseQuery({ where: { "brand.name": { _ilike: "Samsung" } } }, limits);
    expect(ast.where).toEqual({
      type: "comparison",
      path: ["brand", "name"],
      operator: "_ilike",
      value: "Samsung",
    });
  });

  it("parses explicit logical groups", () => {
    const ast = parseQuery(
      { where: { _and: [{ price: { _gt: "10" } }, { price: { _lt: "100" } }] } },
      limits,
    );
    expect(ast.where?.type).toBe("and");
    expect((ast.where as { children: unknown[] }).children).toHaveLength(2);
  });

  it("parses $INTERVAL.* variables", () => {
    const ast = parseQuery({ where: { updated_at: { _gte: "$INTERVAL.24h" } } }, limits);
    expect(ast.where).toEqual({
      type: "comparison",
      path: ["updated_at"],
      operator: "_gte",
      value: { kind: "interval", amount: 24, unit: "h" },
    });
  });

  it("rejects an invalid interval unit", () => {
    expect(() => parseQuery({ where: { updated_at: { _gte: "$INTERVAL.24x" } } }, limits)).toThrow();
  });

  it("parses flags[<name>]=<filter> - named filters, never a filter on the rows (T67)", () => {
    const ast = parseQuery({ flags: { stock_bajo: { stock: { _lte: "0" } }, vencida: { vence: { _lt: "$CURRENT_DATE" } } } }, limits);
    expect(ast.flags?.map((f) => f.name)).toEqual(["stock_bajo", "vencida"]);
    expect(ast.where).toBeUndefined();
    expect(() => parseQuery({ flags: { "1bad": { stock: { _eq: "0" } } } }, limits)).toThrow();
    expect(() => parseQuery({ flags: "stock" }, limits)).toThrow();
  });

  it("parses $ROW.<column> - another column of the same row, never a related one (T68)", () => {
    const ast = parseQuery({ where: { stock: { _lt: "$ROW.stock_minimo" } } }, limits);
    expect(ast.where).toMatchObject({ type: "comparison", path: ["stock"], operator: "_lt", value: { kind: "row", column: "stock_minimo" } });
    expect(() => parseQuery({ where: { stock: { _lt: "$ROW.categoria.minimo" } } }, limits)).toThrow();
    expect(() => parseQuery({ where: { stock: { _lt: "$ROW." } } }, limits)).toThrow();
  });

  it("parses $PERIOD.<period>.<from|to> variables", () => {
    const ast = parseQuery({ where: { updated_at: { _lt: "$PERIOD.last_month.to" } } }, limits);
    expect(ast.where).toEqual({
      type: "comparison",
      path: ["updated_at"],
      operator: "_lt",
      value: { kind: "period", period: "last_month", bound: "to" },
    });
  });

  it("rejects an unknown period, a missing or unknown bound, and anything that isn't exactly the grammar", () => {
    for (const raw of [
      "$PERIOD.next_month.from",
      "$PERIOD.this_month",
      "$PERIOD.this_month.start",
      "$PERIOD.THIS_MONTH.from",
      "$PERIOD.this_month.from ",
      "$PERIOD.this_month.from;",
      "$PERIOD.this_month'); DROP TABLE users; --.from",
      "$PERIOD.this_month.from' OR '1'='1",
    ]) {
      expect(() => parseQuery({ where: { updated_at: { _gte: raw } } }, limits), raw).toThrow(expect.objectContaining({ code: "INVALID_PERIOD" }));
    }
  });

  it("parses $USER.* variables", () => {
    const ast = parseQuery({ where: { branch: { _eq: "$USER.branch" } } }, limits);
    expect(ast.where).toEqual({
      type: "comparison",
      path: ["branch"],
      operator: "_eq",
      value: { kind: "user", field: "branch" },
    });
  });

  it("rejects unknown operators", () => {
    expect(() => parseQuery({ where: { price: { _bogus: "1" } } }, limits)).toThrow();
  });

  it("parses unary operators without a value", () => {
    const ast = parseQuery({ where: { deleted_at: { _null: "" } } }, limits);
    expect(ast.where).toEqual({ type: "comparison", path: ["deleted_at"], operator: "_null", value: undefined });
  });

  it("parses _in as a comma-separated list", () => {
    const ast = parseQuery({ where: { status: { _in: "A,B,C" } } }, limits);
    expect(ast.where).toEqual({
      type: "comparison",
      path: ["status"],
      operator: "_in",
      value: ["A", "B", "C"],
    });
  });

  it("takes a stored filter's JSON numbers, booleans and lists as their text - PostgreSQL casts them", () => {
    const leaf = (where: unknown) => parseFilter(where, limits, 0);
    expect(leaf({ qty: { _lte: 20 } })).toMatchObject({ operator: "_lte", value: "20" });
    expect(leaf({ active: { _eq: true } })).toMatchObject({ operator: "_eq", value: "true" });
    expect(leaf({ status: { _in: ["A", "B,C"] } })).toMatchObject({ operator: "_in", value: ["A", "B,C"] });
    expect(leaf({ qty: { _between: [1, 5] } })).toMatchObject({ operator: "_between", value: ["1", "5"] });
    expect(leaf({ owner: { _in: ["$USER.id"] } })).toMatchObject({ value: [{ kind: "user" }] });
    for (const bad of [{ x: { _eq: ["a"] } }, { x: { _in: [] } }, { x: { _in: [{ a: 1 }] } }, { x: { _between: [1] } }, { x: { _eq: null } }, { x: { _eq: Number.NaN } }]) {
      expect(() => leaf(bad)).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
    }
  });

  it("rejects filter nesting beyond max_filter_depth", () => {
    expect(() =>
      parseQuery({ where: { _and: [{ _and: [{ _and: [{ x: { _eq: "1" } }] }] }] } }, { ...limits, maxFilterDepth: 1 }),
    ).toThrow();
  });
});

describe("parseQuery: order_by / group_by / aggregates", () => {
  it("parses order_by with descending prefix", () => {
    const ast = parseQuery({ order_by: "name,-created_at,brand.name" }, limits);
    expect(ast.orderBy).toEqual([
      { path: ["name"], direction: "ASC" },
      { path: ["created_at"], direction: "DESC" },
      { path: ["brand", "name"], direction: "ASC" },
    ]);
  });

  it("parses group_by", () => {
    const ast = parseQuery({ group_by: "branch.name,status" }, limits);
    expect(ast.groupBy).toEqual([["branch", "name"], ["status"]]);
  });

  it("parses aggregates with required aliases", () => {
    const ast = parseQuery({ _sum: { amount: "total" }, _count: { "*": "count" } }, limits);
    expect(ast.aggregates).toEqual([
      { fn: "_sum", path: ["amount"], alias: "total" },
      { fn: "_count", path: "*", alias: "count" },
    ]);
  });

  it("bounds an aggregate's relation path by maxRelationDepth, like fields and order_by", () => {
    expect(parseQuery({ _sum: { "a.b.c.amount": "total" } }, limits).aggregates).toEqual([{ fn: "_sum", path: ["a", "b", "c", "amount"], alias: "total" }]);
    expect(() => parseQuery({ _sum: { "a.b.c.d.amount": "total" } }, limits)).toThrow(expect.objectContaining({ code: "QUERY_DEPTH_LIMIT_EXCEEDED" }));
    expect(() => parseQuery({ _max: { "a..b": "m" } }, limits)).toThrow(expect.objectContaining({ code: "INVALID_FIELD" }));
  });
});

describe("parseQuery: pagination / count", () => {
  it("parses limit, offset, and count", () => {
    const ast = parseQuery({ limit: "50", offset: "10", count: "true" }, limits);
    expect(ast.limit).toBe(50);
    expect(ast.offset).toBe(10);
    expect(ast.count).toBe(true);
  });

  it("defaults count to false when absent", () => {
    const ast = parseQuery({}, limits);
    expect(ast.count).toBe(false);
    expect(ast.limit).toBeUndefined();
  });
});

describe("parseQuery: maxQueryNodes (Data_API.md §12)", () => {
  it("does not enforce a complexity limit when maxQueryNodes is omitted", () => {
    expect(() => parseQuery({ fields: "a,b,c,d,e,f,g,h,i,j" }, limits)).not.toThrow();
  });

  it("rejects a query whose structural node count exceeds the limit", () => {
    expect(() =>
      parseQuery({ fields: "a,b,c,d,e,f" }, { ...limits, maxQueryNodes: 5 }),
    ).toThrow(/complexity/i);
  });

  it("allows a query at or under the limit", () => {
    expect(() => parseQuery({ fields: "a,b,c" }, { ...limits, maxQueryNodes: 3 })).not.toThrow();
  });
});

describe("assertFilterComplexity: a write's where (Data_API.md §12)", () => {
  const where = { a: { _eq: "1" }, b: { _eq: "2" }, c: { _eq: "3" } };

  it("rejects a filter whose node count exceeds api.max_query_nodes", () => {
    const node = parseFilter(where, limits, 0);
    expect(() => assertFilterComplexity(node, 3)).toThrow(expect.objectContaining({ code: "QUERY_COMPLEXITY_LIMIT_EXCEEDED" }));
  });

  it("allows one at the limit, and no filter at all", () => {
    expect(() => assertFilterComplexity(parseFilter(where, limits, 0), 4)).not.toThrow();
    expect(() => assertFilterComplexity(undefined, 0)).not.toThrow();
  });
});

describe("parseQuery limit and offset", () => {
  it("takes them as query-string text or as JSON integers - a workflow's query object", () => {
    expect(parseQuery({ limit: "5", offset: "10" }, limits)).toMatchObject({ limit: 5, offset: 10 });
    expect(parseQuery({ limit: 1, offset: 0 }, limits)).toMatchObject({ limit: 1, offset: 0 });
  });

  it("refuses what isn't a whole number from zero up", () => {
    for (const limit of [-1, 1.5, "abc", true]) expect(() => parseQuery({ limit }, limits)).toThrow(/Invalid limit/);
  });
});

