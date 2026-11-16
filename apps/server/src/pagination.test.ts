import { describe, expect, it } from "vitest";
import { pageOf } from "./pagination.js";

describe("pageOf", () => {
  it("takes the route's default, or every match without one", () => {
    expect(pageOf({}, { max: 200, defaultLimit: 50 })).toEqual({ limit: 50, offset: 0 });
    expect(pageOf({}, { max: 200 })).toEqual({ limit: undefined, offset: 0 });
    expect(pageOf({ limit: "10", offset: "20" }, { max: 200 })).toEqual({ limit: 10, offset: 20 });
  });

  it("refuses a limit out of range or not a whole number, and a negative or fractional offset", () => {
    for (const limit of ["0", "201", "abc", "1.5", "-1", "1e2"]) {
      expect(() => pageOf({ limit }, { max: 200 })).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
    }
    for (const offset of ["-1", "x", "2.5"]) {
      expect(() => pageOf({ offset }, { max: 200 })).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
    }
  });
});
