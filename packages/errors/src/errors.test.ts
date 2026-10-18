import { describe, expect, it } from "vitest";
import { mapPostgresError } from "./postgres-error-mapper.js";
import { TotalBaseError } from "./totalbase-error.js";

describe("mapPostgresError", () => {
  it.each([
    ["23505", "UNIQUE_VIOLATION", 409],
    ["23503", "FOREIGN_KEY_VIOLATION", undefined],
    ["23001", "FOREIGN_KEY_VIOLATION", undefined],
    ["23514", "CHECK_VIOLATION", 422],
    ["P0001", "RAISE_EXCEPTION", 422],
    // A TRUNCATE of a referenced table answered INTERNAL_ERROR, as if TotalBase had failed (MCP_Demo_Findings.md F17).
    ["0A000", "FEATURE_NOT_SUPPORTED", 400],
  ])("maps SQLSTATE %s to %s", (sqlstate, code, status) => {
    const error = mapPostgresError({ code: sqlstate, message: "boom", detail: "d", hint: "h" });
    expect(error.code).toBe(code);
    expect(error.source).toBe("POSTGRESQL");
    expect(error.sqlstate).toBe(sqlstate);
    if (status !== undefined) expect(error.httpStatus).toBe(status);
  });

  it("keeps PostgreSQL's own message - a RAISE EXCEPTION reads as written", () => {
    expect(mapPostgresError({ code: "P0001", message: "Stock can't go negative" }).message).toBe("Stock can't go negative");
  });

  it("keeps PostgreSQL's error position as a number (1-based character offset)", () => {
    expect(mapPostgresError({ code: "42601", message: "syntax error", position: "8" }).position).toBe(8);
    expect(mapPostgresError({ code: "42601", message: "syntax error" }).position).toBeUndefined();
    expect(mapPostgresError({ code: "42601", message: "syntax error", position: "x" }).position).toBeUndefined();
  });

  it.each([
    ["42803", "GROUPING_ERROR", 400],
    ["42804", "DATATYPE_MISMATCH", 400],
    ["42883", "UNDEFINED_FUNCTION", 400],
    ["42702", "AMBIGUOUS_COLUMN", 400],
    ["22012", "DIVISION_BY_ZERO", 422],
    ["22003", "NUMERIC_VALUE_OUT_OF_RANGE", 422],
    ["22007", "INVALID_DATETIME_FORMAT", 400],
    ["22008", "DATETIME_FIELD_OVERFLOW", 400],
    // Class fallbacks: an unnamed SQLSTATE of class 42 or 22 is the statement's or the input's fault - a 400, not a 500.
    ["42P10", "INVALID_STATEMENT", 400],
    ["42P18", "INVALID_STATEMENT", 400],
    ["22023", "DATA_EXCEPTION", 400],
  ])("maps SQLSTATE %s to %s (%i)", (sqlstate, code, status) => {
    const error = mapPostgresError({ code: sqlstate, message: "boom" });
    expect([error.code, error.httpStatus]).toEqual([code, status]);
  });

  it("falls back to INTERNAL_ERROR for an unmapped SQLSTATE", () => {
    expect(mapPostgresError({ code: "53200", message: "out of memory" }).code).toBe("INTERNAL_ERROR");
    expect(mapPostgresError({ code: "XX999", message: "?" }).code).toBe("INTERNAL_ERROR");
    expect(mapPostgresError({ message: "no code" }).httpStatus).toBe(500);
  });
});

describe("TotalBaseError", () => {
  it("never puts PostgreSQL diagnostics in the public Data API shape (AGENTS.md section 20)", () => {
    const error = new TotalBaseError("CHECK_VIOLATION", "Violates check", { source: "POSTGRESQL", detail: "Failing row contains (secret)", hint: "h", sqlstate: "23514", position: 12 });
    expect(error.toPublicJSON()).toEqual({ source: "POSTGRESQL", code: "CHECK_VIOLATION", message: "Violates check" });
    expect(error.toAdminJSON()).toEqual({
      source: "POSTGRESQL", code: "CHECK_VIOLATION", message: "Violates check",
      detail: "Failing row contains (secret)", hint: "h", sqlstate: "23514", position: 12,
    });
  });

  it("takes its HTTP status from the code unless told otherwise", () => {
    expect(new TotalBaseError("UNIQUE_VIOLATION", "dup").httpStatus).toBe(409);
    expect(new TotalBaseError("UNIQUE_VIOLATION", "dup", { httpStatus: 400 }).httpStatus).toBe(400);
  });
});
