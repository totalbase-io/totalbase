import { TotalBaseError } from "@totalbase/errors";
import { describe, expect, it } from "vitest";
import { bindSqlVariables, listSqlVariableRefs, referencedVariableNames } from "./sql-variables.js";

const noopResolve = async () => ({ value: null, cast: "text" });

describe("scanSqlVariables / bindSqlVariables", () => {
  it("binds $USER and $VAR references as parenthesized cast parameters, reusing repeats", async () => {
    const bound = await bindSqlVariables(
      "SELECT * FROM t WHERE owner = $USER.id AND s = $VAR.status AND o = $USER.id",
      async (ref) => ({ value: ref.kind, cast: ref.kind === "USER" ? "uuid" : "text" }),
    );
    expect(bound.sql).toBe("SELECT * FROM t WHERE owner = ($1::uuid) AND s = ($2::text) AND o = ($1::uuid)");
    expect(bound.params).toEqual(["USER", "VAR"]);
  });

  it("parses .from/.to only on $VAR", () => {
    expect(listSqlVariableRefs("x >= $VAR.period.from AND x < $VAR.period.to")).toEqual([
      { kind: "VAR", name: "period", part: "from" },
      { kind: "VAR", name: "period", part: "to" },
    ]);
    expect(listSqlVariableRefs("$USER.name.from")).toEqual([{ kind: "USER", field: "name" }]);
  });

  it("leaves references inside literals, quoted identifiers, comments and dollar-quoted bodies untouched", async () => {
    const sql = [
      "SELECT '$USER.id' AS a,",
      "E'it\\'s $VAR.x' AS b,",
      '"$VAR.col" AS c,',
      "$body$ $USER.id $body$ AS d,",
      "$$ $VAR.y $$ AS e -- $VAR.z",
      "/* $USER.id /* nested $VAR.q */ */",
    ].join("\n");
    const bound = await bindSqlVariables(sql, noopResolve);
    expect(bound.sql).toBe(sql);
    expect(bound.params).toEqual([]);
  });

  it("treats $ after an identifier character as part of the identifier", () => {
    expect(listSqlVariableRefs("SELECT col$USER.id")).toEqual([]);
  });

  it("rejects hand-written positional parameters", () => {
    expect(() => listSqlVariableRefs("SELECT $1")).toThrow(TotalBaseError);
  });

  it("rejects unterminated literals instead of guessing", () => {
    expect(() => listSqlVariableRefs("SELECT 'open")).toThrow(TotalBaseError);
    expect(() => listSqlVariableRefs("SELECT $x$ open")).toThrow(TotalBaseError);
  });

  it("lists referenced $VAR names for selective re-runs", () => {
    expect(referencedVariableNames("SELECT 1 WHERE a = $VAR.a AND b >= $VAR.p.from AND c = $USER.id AND d = $VAR.a")).toEqual(["a", "p"]);
    expect(referencedVariableNames(null)).toEqual([]);
  });
});
