import { describe, expect, it } from "vitest";
import { quoteIdentifier, validateDataType, validateFkAction, validateIdentifier, validateSqlExpression } from "./validation.js";

describe("validateIdentifier", () => {
  it("accepts normal identifiers", () => {
    expect(() => validateIdentifier("products", "table")).not.toThrow();
    expect(() => validateIdentifier("_private", "table")).not.toThrow();
    expect(() => validateIdentifier("a".repeat(63), "table")).not.toThrow();
  });

  it("rejects empty, too-long, and unsafe identifiers", () => {
    expect(() => validateIdentifier("", "table")).toThrow();
    expect(() => validateIdentifier("a".repeat(64), "table")).toThrow();
    expect(() => validateIdentifier("1abc", "table")).toThrow();
    expect(() => validateIdentifier("bad name", "table")).toThrow();
    expect(() => validateIdentifier('bad"name', "table")).toThrow();
    expect(() => validateIdentifier("bad;name", "table")).toThrow();
    expect(() => validateIdentifier("bad.name", "table")).toThrow();
  });
});

describe("quoteIdentifier", () => {
  it("wraps in double quotes and escapes embedded quotes", () => {
    expect(quoteIdentifier("products")).toBe('"products"');
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
  });
});

describe("validateDataType", () => {
  it("accepts common PostgreSQL type spellings", () => {
    for (const type of ["uuid", "text", "numeric(12,2)", "character varying(255)", "text[]", "timestamptz"]) {
      expect(() => validateDataType(type)).not.toThrow();
    }
  });

  it("rejects types with embedded expressions or statements", () => {
    for (const type of ["uuid; DROP TABLE users", "text -- comment", "text)); DROP TABLE users; --"]) {
      expect(() => validateDataType(type)).toThrow();
    }
  });
});

describe("validateSqlExpression", () => {
  it("accepts ordinary boolean/value expressions", () => {
    for (const expr of ["price >= 0", "(price >= 0) AND (stock >= 0)", "char_length(name) > 0", "now()"]) {
      expect(() => validateSqlExpression(expr, "CHECK")).not.toThrow();
    }
  });

  it("rejects stacked statements, comments, dollar-quoting, and dangerous keywords", () => {
    const attacks = [
      "price >= 0); DROP TABLE users; --",
      "price >= 0 -- comment",
      "price >= 0 /* comment */",
      "price >= 0; SELECT pg_sleep(1)",
      "$$ DROP TABLE users $$",
      "1=1) OR (SELECT DROP TABLE users",
      "(SELECT 1); TRUNCATE users",
    ];
    for (const expr of attacks) {
      expect(() => validateSqlExpression(expr, "CHECK")).toThrow();
    }
  });

  it("rejects unbalanced parentheses", () => {
    expect(() => validateSqlExpression("(price >= 0", "CHECK")).toThrow();
    expect(() => validateSqlExpression("price >= 0)", "CHECK")).toThrow();
  });

  it("rejects empty and overlong expressions", () => {
    expect(() => validateSqlExpression("", "CHECK")).toThrow();
    expect(() => validateSqlExpression("x".repeat(2001), "CHECK")).toThrow();
  });
});

describe("validateFkAction", () => {
  it("accepts the five PostgreSQL referential actions", () => {
    for (const action of ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]) {
      expect(validateFkAction(action, "ON DELETE")).toBe(action);
    }
  });

  it("rejects anything else", () => {
    expect(() => validateFkAction("DROP TABLE users", "ON DELETE")).toThrow();
    expect(() => validateFkAction("cascade", "ON DELETE")).toThrow(); // case-sensitive, matches PostgreSQL keyword casing
  });
});
