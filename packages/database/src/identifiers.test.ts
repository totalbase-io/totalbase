import { describe, expect, it } from "vitest";
import { quoteIdentifier } from "./identifiers.js";

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
