import { describe, expect, it } from "vitest";
import { assertViewConfigShape } from "./view-config.js";

describe("assertViewConfigShape() - layouts (DataViews.md §5.13)", () => {
  it("takes a list DataView's views in order, and null", () => {
    expect(() => assertViewConfigShape("TABLE", { layouts: ["TABLE", "MAP", "CARDS"] })).not.toThrow();
    expect(() => assertViewConfigShape("CARDS", { layouts: null })).not.toThrow();
  });

  it("refuses a view twice, a type that isn't a list, an empty list, and layouts on a FORM", () => {
    for (const [type, layouts] of [["TABLE", ["TABLE", "TABLE"]], ["TABLE", ["FORM"]], ["TABLE", []], ["FORM", ["TABLE"]]] as const) {
      expect(() => assertViewConfigShape(type, { layouts })).toThrow(expect.objectContaining({ code: "DATAVIEW_VIEW_CONFIG_INVALID" }));
    }
  });

  it("takes a tree's layout, refusing a display or an open level it doesn't know (§5.14)", () => {
    expect(() => assertViewConfigShape("TREE", { layouts: ["TREE", "TABLE"], tree_layout: { parentColumn: "parent", defaultDisplay: "org", expandLevel: 2 } })).not.toThrow();
    for (const tree_layout of [{ defaultDisplay: "chart" }, { expandLevel: 21 }, { parentColumn: 3 }]) {
      expect(() => assertViewConfigShape("TREE", { tree_layout })).toThrow(expect.objectContaining({ code: "DATAVIEW_VIEW_CONFIG_INVALID" }));
    }
  });

  it("lets a list's features carry another list type's keys - it may switch to that view", () => {
    expect(() => assertViewConfigShape("CARDS", { features: { rowEdit: false } })).not.toThrow();
  });
});

describe("assertViewConfigShape() - kiosk (DataViews.md §7.3)", () => {
  it("takes kiosk on a CUSTOM page - true, false or null back to the default", () => {
    for (const kiosk of [true, false, null]) expect(() => assertViewConfigShape("CUSTOM", { kiosk })).not.toThrow();
  });

  it("refuses kiosk as text, and on any other type", () => {
    expect(() => assertViewConfigShape("CUSTOM", { kiosk: "true" })).toThrow(expect.objectContaining({ code: "DATAVIEW_VIEW_CONFIG_INVALID" }));
    for (const type of ["TABLE", "FORM", "MASTER_DETAIL", "EXTERNALFRAME"]) {
      expect(() => assertViewConfigShape(type, { kiosk: true })).toThrow(expect.objectContaining({ code: "DATAVIEW_VIEW_CONFIG_INVALID" }));
    }
  });
});
