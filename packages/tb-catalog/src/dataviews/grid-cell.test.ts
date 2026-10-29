import { describe, expect, it } from "vitest";
import { GRID_COLUMN_DEFAULT_MAX_WIDTH, gridCellConfigProblem, gridColumnWidths } from "./grid-cell.js";

describe("gridCellConfigProblem", () => {
  it("takes an empty config and every key in range", () => {
    expect(gridCellConfigProblem({})).toBeNull();
    expect(gridCellConfigProblem({ textWrap: "wrap", maxLines: 3, verticalAlign: "top", width: 120, minWidth: 80, maxWidth: 400 })).toBeNull();
    expect(gridCellConfigProblem({ width: null, textWrap: null })).toBeNull();
  });

  it("refuses a value it can't take", () => {
    expect(gridCellConfigProblem({ textWrap: "clip" })).toMatch(/textWrap/);
    expect(gridCellConfigProblem({ maxLines: 0 })).toMatch(/maxLines/);
    expect(gridCellConfigProblem({ maxLines: 2.5 })).toMatch(/maxLines/);
    expect(gridCellConfigProblem({ verticalAlign: "center" })).toMatch(/verticalAlign/);
    expect(gridCellConfigProblem({ width: 10 })).toMatch(/width/);
    expect(gridCellConfigProblem({ maxWidth: "300px" })).toMatch(/maxWidth/);
    expect(gridCellConfigProblem({ minWidth: 300, maxWidth: 200 })).toMatch(/minWidth/);
  });
});

describe("gridColumnWidths", () => {
  it("caps a column with no width of its own", () => {
    expect(gridColumnWidths({})).toEqual({ maxWidth: GRID_COLUMN_DEFAULT_MAX_WIDTH });
  });

  it("lifts the cap to a wider width or minimum", () => {
    expect(gridColumnWidths({ width: 500 })).toEqual({ width: 500, maxWidth: 500 });
    expect(gridColumnWidths({ minWidth: 450 })).toEqual({ minWidth: 450, maxWidth: 450 });
  });

  it("keeps a width within its own maximum", () => {
    expect(gridColumnWidths({ width: 500, maxWidth: 200 })).toEqual({ width: 200, maxWidth: 200 });
  });
});
