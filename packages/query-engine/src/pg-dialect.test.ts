import { describe, expect, it } from "vitest";
import { pointLiteral } from "./pg-dialect.js";

describe("pointLiteral", () => {
  it("converts a { lng, lat } object to Postgres's (x,y) literal", () => {
    expect(pointLiteral({ lng: -58.38, lat: -34.6 })).toBe("(-58.38,-34.6)");
  });

  it("accepts a [lng, lat] tuple defensively", () => {
    expect(pointLiteral([10, 20])).toBe("(10,20)");
  });

  it("passes null/undefined through unchanged", () => {
    expect(pointLiteral(null)).toBeNull();
    expect(pointLiteral(undefined)).toBeNull();
  });

  it("rejects a value with no recognizable lng/lat shape", () => {
    expect(() => pointLiteral("not a point")).toThrow(/Expected a point value/);
    expect(() => pointLiteral({ x: 1, y: 2 })).toThrow(/Expected a point value/);
  });

  it("rejects non-finite or non-numeric coordinates", () => {
    expect(() => pointLiteral({ lng: "1", lat: 2 })).toThrow(/finite numbers/);
    expect(() => pointLiteral({ lng: Number.POSITIVE_INFINITY, lat: 2 })).toThrow(/finite numbers/);
  });
});
