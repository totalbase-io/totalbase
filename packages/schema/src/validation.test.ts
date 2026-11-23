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

// Security regression (Administration.md §3.2): the expression check counted parentheses inside string literals and
// knew only `$$` as dollar-quoting, and a DEFAULT went into ALTER TABLE unparenthesized - `0, DISABLE ROW LEVEL
// SECURITY` added a second action. A type name took any words after it (`integer PRIMARY KEY`).
describe("an expression or a type never adds a clause", () => {
  it("refuses a parenthesis that closes the expression's own, wherever quotes hide it", () => {
    for (const expression of [
      "0), DISABLE ROW LEVEL SECURITY, ALTER COLUMN c SET DEFAULT (0",
      "'(' = 'a') , ADD COLUMN pwn text DEFAULT (')'",
      "E'\\'') , ADD COLUMN x int, ALTER COLUMN c SET DEFAULT (0",
      "'unterminated",
      '"unterminated',
      "$a$)$a$ = 'x'",
    ]) {
      expect(() => validateSqlExpression(expression, "DEFAULT"), expression).toThrow();
    }
  });

  // Security regression (Administration.md §3.2): a tag holding digits or non-ASCII letters (`$a1$`, `$ñ$`) - which
  // PostgreSQL takes - passed the dollar-quoting check, and the quote hid a closing parenthesis.
  it("refuses dollar-quoting whatever its tag holds", () => {
    for (const expression of ["$a1$)$a1$ = 'x'", "$ñ$) , ADD COLUMN x int, ALTER COLUMN c SET DEFAULT ($ñ$ = 'x'", "$_9$x$_9$ = name", "$$x$$ = name"]) {
      expect(() => validateSqlExpression(expression, "DEFAULT"), expression).toThrow(/dollar-quoting/);
    }
  });

  it("still takes what quotes legitimately hold", () => {
    for (const expression of ["name <> ')'", "note ~ '^\\(x\\)$'", "label = 'it''s (fine)'", "E'a\\'b' = label", `"Weird ) name" > 0`]) {
      expect(() => validateSqlExpression(expression, "CHECK"), expression).not.toThrow();
    }
  });

  it("refuses words after a type that aren't the type's own", () => {
    for (const type of ["integer PRIMARY KEY", "text NOT NULL UNIQUE", "integer REFERENCES users", "integer USING other_col", "text COLLATE C"]) {
      expect(() => validateDataType(type), type).toThrow();
    }
    for (const type of ["character varying(255)", "double precision", "timestamp with time zone", "Timestamp  Without Time Zone", "numeric(12,2)", "text[]", "my_enum"]) {
      expect(() => validateDataType(type), type).not.toThrow();
    }
  });
});
