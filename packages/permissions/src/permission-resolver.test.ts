import { describe, expect, it } from "vitest";
import { isAuthorized, resolveEffect } from "./permission-resolver.js";

describe("resolveEffect", () => {
  it("returns UNDEFINED when there are no grants", () => {
    expect(resolveEffect([])).toBe("UNDEFINED");
  });

  it("returns ALLOW when only ALLOW grants exist", () => {
    expect(resolveEffect([{ effect: "ALLOW" }])).toBe("ALLOW");
  });

  it("returns DENY when any DENY exists, even alongside ALLOW", () => {
    expect(resolveEffect([{ effect: "ALLOW" }, { effect: "DENY" }])).toBe("DENY");
    expect(resolveEffect([{ effect: "DENY" }, { effect: "ALLOW" }])).toBe("DENY");
  });

  it("follows DENY > ALLOW > UNDEFINED regardless of grant order", () => {
    const grants = [{ effect: "ALLOW" as const }, { effect: "ALLOW" as const }, { effect: "DENY" as const }];
    expect(resolveEffect(grants)).toBe("DENY");
  });
});

describe("isAuthorized", () => {
  it("is true only for ALLOW", () => {
    expect(isAuthorized("ALLOW")).toBe(true);
    expect(isAuthorized("DENY")).toBe(false);
    expect(isAuthorized("UNDEFINED")).toBe(false);
  });
});
