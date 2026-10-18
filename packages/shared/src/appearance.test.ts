import { describe, expect, it } from "vitest";
import { hexToOklch, primaryColorCss, primaryShades, validateCustomCss } from "./appearance.js";

describe("primary color shades (Specification_Admin_UI.md §4.1.1)", () => {
  it("keeps the color as shade 500 and its hue on every shade, lighter toward 50 and darker toward 950", () => {
    const { l, c, h } = hexToOklch("#0f766e");
    const shades = primaryShades("#0f766e");
    const parse = (v: string) => v.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/)!.slice(1).map(Number);
    const [l500, c500, h500] = parse(shades[500]);
    expect(l500).toBeCloseTo(l, 3);
    expect(c500).toBeCloseTo(c, 3);
    expect(h500).toBeCloseTo(h, 3);
    const order = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
    const lightness = order.map((s) => parse(shades[s])[0]!);
    for (let i = 1; i < lightness.length; i++) expect(lightness[i]!).toBeLessThan(lightness[i - 1]!);
    for (const s of order) expect(parse(shades[s])[2]).toBeCloseTo(h, 3);
  });

  it("keeps a gray gray", () => {
    for (const v of Object.values(primaryShades("#808080"))) expect(v).toMatch(/oklch\([\d.]+ 0 0\)/);
  });

  it("writes the :root rule Nuxt UI reads, and nothing for no color or a bad one", () => {
    const css = primaryColorCss("#2563EB");
    expect(css.startsWith(":root {\n")).toBe(true);
    expect(css).toContain("--ui-color-primary-50:");
    expect(css).toContain("--ui-color-primary-950:");
    expect(primaryColorCss("")).toBe("");
    expect(primaryColorCss("blue")).toBe("");
    expect(primaryColorCss("#fff")).toBe("");
  });
});

describe("custom CSS", () => {
  it("accepts plain rules, refuses @import and a sheet over 64 KB", () => {
    expect(validateCustomCss(":root { --ui-radius: 0 }")).toBeNull();
    expect(validateCustomCss("")).toBeNull();
    expect(validateCustomCss('@import url("https://evil.example/x.css");')).toMatch(/@import/);
    expect(validateCustomCss("@IMPORT 'x.css';")).toMatch(/@import/);
    expect(validateCustomCss("a{}".repeat(30_000))).toMatch(/64 KB/);
    expect(validateCustomCss(5)).toBe("Expected text.");
  });
});
