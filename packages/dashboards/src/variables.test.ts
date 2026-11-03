import { describe, expect, it } from "vitest";
import { dateRangeBoundsSql, normalizeVariableValue, validateVariables, type DashboardVariable } from "./variables.js";

const day: DashboardVariable = { name: "p", label: "P", type: "DATE_RANGE" };
const minute: DashboardVariable = { name: "p", label: "P", type: "DATE_RANGE", precision: "minute" };

/** A DATE_RANGE's precision (Dashboards.md §3.3-§3.5): the custom value's grammar and the `to` rule. */
describe("DATE_RANGE precision", () => {
  it("day (the default) takes two dates, the last day included - as before", () => {
    expect(normalizeVariableValue(day, { from: "2026-11-02", to: "2026-11-03" })).toEqual({ from: "2026-11-02", to: "2026-11-03" });
    expect(normalizeVariableValue(day, { from: "2026-11-02", to: "2026-11-02" })).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    expect(() => normalizeVariableValue(day, { from: "2026-11-03", to: "2026-11-02" })).toThrow(/from is after to/);
    // A time at day precision is refused: a picker never shows what the server would round away.
    expect(() => normalizeVariableValue(day, { from: "2026-11-02T22:30", to: "2026-11-03T09:00" })).toThrow(/YYYY-MM-DD date/);
    expect(dateRangeBoundsSql({ from: "2026-11-02", to: "2026-11-03" })).toMatchObject({ sql: expect.stringContaining("($2::date + 1)::timestamptz"), params: ["2026-11-02", "2026-11-03"] });
  });

  it("minute takes YYYY-MM-DDTHH:MM bounds, `to` exclusive as written", () => {
    expect(normalizeVariableValue(minute, { from: "2026-11-02T22:30", to: "2026-11-03T09:00" })).toEqual({ from: "2026-11-02T22:30", to: "2026-11-03T09:00" });
    expect(() => normalizeVariableValue(minute, { from: "2026-11-03T09:00", to: "2026-11-03T09:00" })).toThrow(/from must be before to/);
    expect(() => normalizeVariableValue(minute, { from: "2026-11-03T09:00", to: "2026-11-02T22:30" })).toThrow(/from must be before to/);
    expect(dateRangeBoundsSql({ from: "2026-11-02T22:30", to: "2026-11-03T09:00" }, "minute")).toMatchObject({
      sql: expect.stringContaining("$2::timestamp::timestamptz"),
      params: ["2026-11-02T22:30", "2026-11-03T09:00"],
    });
  });

  it("minute is a superset of day: a bare date means the whole day, as day precision does", () => {
    expect(normalizeVariableValue(minute, { from: "2026-11-02", to: "2026-11-03" })).toEqual({ from: "2026-11-02T00:00", to: "2026-11-04T00:00" });
    expect(normalizeVariableValue(minute, { from: "2026-12-31", to: "2026-12-31" })).toEqual({ from: "2026-12-31T00:00", to: "2027-01-01T00:00" });
    expect(normalizeVariableValue(minute, { from: "2026-02-28", to: "2026-11-03T09:00" })).toEqual({ from: "2026-02-28T00:00", to: "2026-11-03T09:00" });
  });

  it("refuses seconds, a zone designator and a malformed bound, naming the grammar", () => {
    for (const to of ["2026-11-03T09:00:15", "2026-11-03T09:00Z", "2026-11-03 09:00", "2026-11-03T9:00", "yesterday"]) {
      expect(() => normalizeVariableValue(minute, { from: "2026-11-02T22:30", to })).toThrow(/YYYY-MM-DDTHH:MM/);
    }
  });

  it("presets and unset are the same at both precisions", () => {
    expect(normalizeVariableValue(minute, "today")).toBe("today");
    expect(normalizeVariableValue(minute, null)).toBeNull();
    expect(dateRangeBoundsSql("today", "minute")).toEqual(dateRangeBoundsSql("today"));
  });
});

describe("validateVariables: precision and description", () => {
  it("keeps a precision on a DATE_RANGE and validates its constant default with it", () => {
    const [variable] = validateVariables([{ name: "p", label: "P", type: "DATE_RANGE", precision: "minute", default: { source: "constant", value: { from: "2026-11-02T22:30", to: "2026-11-03T09:00" } } }]);
    expect(variable).toMatchObject({ precision: "minute", default: { source: "constant", value: { from: "2026-11-02T22:30", to: "2026-11-03T09:00" } } });
    expect(validateVariables([{ name: "p", label: "P", type: "DATE_RANGE" }])[0]).not.toHaveProperty("precision");
    expect(() => validateVariables([{ name: "p", label: "P", type: "DATE_RANGE", default: { source: "constant", value: { from: "2026-11-02T22:30", to: "2026-11-03T09:00" } } }])).toThrow(/YYYY-MM-DD date/);
  });

  it("refuses a precision on another type, or one it doesn't have", () => {
    expect(() => validateVariables([{ name: "t", label: "T", type: "TEXT", precision: "minute" }])).toThrow(/only a DATE_RANGE has a precision/);
    expect(() => validateVariables([{ name: "p", label: "P", type: "DATE_RANGE", precision: "second" }])).toThrow(/precision must be one of day, minute/);
  });

  it("keeps a trimmed description of at most 128 characters", () => {
    expect(validateVariables([{ name: "p", label: "P", type: "DATE_RANGE", description: "  The period the KPIs count.  " }])[0]).toMatchObject({ description: "The period the KPIs count." });
    expect(validateVariables([{ name: "p", label: "P", type: "DATE_RANGE", description: "   " }])[0]).not.toHaveProperty("description");
    expect(() => validateVariables([{ name: "p", label: "P", type: "DATE_RANGE", description: "x".repeat(129) }])).toThrow(/longer than 128/);
    expect(() => validateVariables([{ name: "p", label: "P", type: "DATE_RANGE", description: 3 }])).toThrow(/description is text/);
  });
});
