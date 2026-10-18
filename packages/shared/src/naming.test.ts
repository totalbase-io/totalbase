import { describe, expect, it } from "vitest";
import { slugify, validateDescription, validateName, validateSlug } from "./naming.js";

describe("validateName (AGENTS.md section 10.1)", () => {
  it("trims and accepts letters, digits, spaces and hyphens in any script", () => {
    expect(validateName("  Órdenes de compra  ")).toBe("Órdenes de compra");
    expect(validateName("Отчёт-2026")).toBe("Отчёт-2026");
  });

  it("accepts a title's ordinary punctuation, and names the character it refuses (DB23)", () => {
    expect(validateName("VIP: actividad")).toBe("VIP: actividad");
    expect(validateName("Ventas (2026), altas & bajas")).toBe("Ventas (2026), altas & bajas");
    expect(() => validateName("price $")).toThrow(expect.objectContaining({ code: "INVALID_NAME", message: expect.stringMatching(/^name can't contain "\$" - letters, digits, spaces and /) }));
  });

  it("refuses a missing name as INVALID_NAME, never a crash", () => {
    for (const raw of [undefined, null, 7]) expect(() => validateName(raw)).toThrow(expect.objectContaining({ code: "INVALID_NAME", message: "name is required" }));
  });

  it.each(["", "   ", "a".repeat(33), "reports/2026", "a\\b", "price $", "<script>", "line\nbreak", "tab\there"])("rejects %j", (raw) => {
    expect(() => validateName(raw)).toThrow();
  });
});

describe("validateDescription", () => {
  it("is optional and trimmed; blank becomes null", () => {
    expect(validateDescription(undefined)).toBeNull();
    expect(validateDescription("   ")).toBeNull();
    expect(validateDescription(" A note ")).toBe("A note");
  });

  it("caps at 128 characters", () => {
    expect(validateDescription("x".repeat(128))).toHaveLength(128);
    expect(() => validateDescription("x".repeat(129))).toThrow();
  });
});

describe("validateSlug", () => {
  it("accepts lowercase ASCII words joined by single hyphens", () => {
    expect(validateSlug("monthly-sales-2026")).toBe("monthly-sales-2026");
  });

  it.each(["", "Upper", "double--hyphen", "-leading", "trailing-", "with space", "ñandú", "a".repeat(33)])("rejects %j", (raw) => {
    expect(() => validateSlug(raw)).toThrow();
  });
});

describe("slugify", () => {
  it.each([
    ["Órdenes de Compra", "ordenes-de-compra"],
    ["  Sales__Report  2026 ", "sales-report-2026"],
    ["Hello, World!", "hello-world"],
    ["---", ""],
  ])("%j -> %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("always proposes a valid slug (or an empty one) no longer than 32 characters", () => {
    const long = slugify("A very long dashboard name that keeps going and going");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(() => validateSlug(long)).not.toThrow();
    expect(long.endsWith("-")).toBe(false);
  });
});
