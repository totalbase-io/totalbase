import { describe, expect, it } from "vitest";
import { quoteIdentifier, quoteLiteral } from "./sql-quoting.js";

describe("quoteIdentifier", () => {
  it("wraps a name in double quotes", () => {
    expect(quoteIdentifier("orders")).toBe('"orders"');
    expect(quoteIdentifier("Order Items")).toBe('"Order Items"');
  });

  it("doubles embedded quotes, so a name can never close the identifier early", () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteIdentifier('x"; DROP TABLE users; --')).toBe('"x""; DROP TABLE users; --"');
  });
});

describe("quoteLiteral", () => {
  it("wraps a text in single quotes and doubles embedded ones, so it can never close the constant early", () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral("x'; DROP TABLE users; --")).toBe("'x''; DROP TABLE users; --'");
  });

  it("leaves a backslash as plain text - standard_conforming_strings", () => {
    expect(quoteLiteral("C:\\path")).toBe("'C:\\path'");
  });
});

// Security regression: PostgreSQL ends a statement's text at a NUL byte - inside an open quoted identifier or string
// constant, it would cut the statement.
describe("a NUL character", () => {
  it("is never quoted into SQL", () => {
    expect(() => quoteIdentifier("a\u0000b")).toThrow(/NUL/);
    expect(() => quoteLiteral("a\u0000b")).toThrow(/NUL/);
  });
});
