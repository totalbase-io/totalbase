import { describe, expect, it } from "vitest";
import { authorPattern, checkConstraintPatterns } from "./regex-patterns.js";

const check = (expression: string, message: string | null = null) => ({ expression, message });
const test = (pattern: { source: string; flags: string }, value: string) => new RegExp(pattern.source, pattern.flags).test(value);

describe("authorPattern", () => {
  it("matches the whole value, like HTML's pattern", () => {
    const pattern = authorPattern("[0-9]{11}")!;
    expect(pattern.test("20123456789")).toBe(true);
    expect(pattern.test("x20123456789")).toBe(false);
    expect(pattern.test("201234567890")).toBe(false);
  });

  it("keeps an alternation whole", () => {
    const pattern = authorPattern("a|b")!;
    expect(pattern.test("a")).toBe(true);
    expect(pattern.test("ab")).toBe(false);
  });

  it("is null when it doesn't compile", () => {
    expect(authorPattern("[0-9")).toBeNull();
    expect(authorPattern("(")).toBeNull();
  });
});

// As pg_get_constraintdef renders them (PostgreSQL 15-18).
describe("checkConstraintPatterns", () => {
  it("reads a column's pattern, with the constraint's message", () => {
    const [pattern] = checkConstraintPatterns("cae", [check("CHECK ((cae ~ '^\\d{14}$'::text))", "CAE: 14 digits")]);
    expect(pattern).toEqual({ source: "^\\d{14}$", flags: "s", message: "CAE: 14 digits" });
    expect(test(pattern!, "12345678901234")).toBe(true);
    expect(test(pattern!, "1234")).toBe(false);
  });

  it("matches anywhere, as ~ does, and ~* ignores case", () => {
    const [anywhere] = checkConstraintPatterns("a", [check("CHECK ((a ~ '[0-9]'::text))")]);
    expect(test(anywhere!, "abc1")).toBe(true);
    const [insensitive] = checkConstraintPatterns("b", [check("CHECK (((b)::text ~* 'it''s\\.x'::text))")]);
    expect(insensitive!.flags).toBe("is");
    expect(test(insensitive!, "IT'S.X")).toBe(true);
    expect(test(insensitive!, "its-x")).toBe(false);
  });

  it("reads a quoted column and a pattern ANDed with other conditions", () => {
    expect(checkConstraintPatterns("Cód", [check(`CHECK (("Cód" ~ '^[0-9]+$'::text))`)])).toHaveLength(1);
    const email = "CHECK (((email = btrim(email)) AND (length(email) <= 254) AND (email ~ '^[^[:space:]@]+@[^[:space:]@]+$'::text)))";
    const [pattern] = checkConstraintPatterns("email", [check(email)]);
    expect(pattern!.source).toBe("^[^\\s@]+@[^\\s@]+$");
    expect(test(pattern!, "ana@example.com")).toBe(true);
    expect(test(pattern!, "ana @example.com")).toBe(false);
  });

  it("takes only the column's own pattern", () => {
    const expressions = [check("CHECK ((other ~ 'x'::text))"), check("CHECK ((a ~ 'y'::text))")];
    expect(checkConstraintPatterns("a", expressions).map((p) => p.source)).toEqual(["y"]);
    expect(checkConstraintPatterns("b", expressions)).toEqual([]);
  });

  it("skips a pattern that isn't required alone", () => {
    expect(checkConstraintPatterns("i", [check("CHECK (((i IS NULL) OR (i ~ '^x$'::text)))")])).toEqual([]);
    expect(checkConstraintPatterns("d", [check("CHECK ((d !~ 'x'::text))")])).toEqual([]);
    expect(checkConstraintPatterns("w", [check("CHECK ((w ~~* '%https%'::text))")])).toEqual([]);
    expect(checkConstraintPatterns("n", [check("CHECK (((n IS NOT NULL) AND (n ~ '^x$'::text)))")])).toHaveLength(1);
  });

  it("skips what might mean something else in JavaScript", () => {
    for (const pattern of ["[[:alpha:]]+", "\\mword\\M", "\\yx", "\\w+", "(?i)abc", "***:abc", "[]a]", "[[.a.]]", "\\Aabc\\Z"]) {
      expect(checkConstraintPatterns("c", [check(`CHECK ((c ~ '${pattern}'::text))`)]), pattern).toEqual([]);
    }
  });

  it("translates the POSIX classes that mean the same", () => {
    const [pattern] = checkConstraintPatterns("c", [check("CHECK ((c ~ '^[[:digit:]]+[[:xdigit:]]$'::text))")]);
    expect(pattern!.source).toBe("^[0-9]+[0-9A-Fa-f]$");
  });

  it("lets . match a newline, as PostgreSQL's does", () => {
    const [pattern] = checkConstraintPatterns("t", [check("CHECK ((t ~ '^a.b$'::text))")]);
    expect(test(pattern!, "a\nb")).toBe(true);
  });
});
