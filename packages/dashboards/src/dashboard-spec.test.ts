import { describe, expect, it } from "vitest";
import { placeWidgets } from "./dashboard-spec.js";

const size = (w: number, h: number) => ({ size: { w, h } });

describe("placeWidgets", () => {
  it("places in order at each type's size, and a row of four KPIs is left as it is", () => {
    expect(placeWidgets([size(3, 2), size(3, 2), size(3, 2), size(3, 2)])).toEqual([
      { x: 0, y: 0, w: 3, h: 2 }, { x: 3, y: 0, w: 3, h: 2 }, { x: 6, y: 0, w: 3, h: 2 }, { x: 9, y: 0, w: 3, h: 2 },
    ]);
  });

  it("shares a row's empty end between its widgets, the remainder to the last", () => {
    // A donut (4) and a bar (6) leave 2 columns: each gets one. A single widget takes the whole row.
    expect(placeWidgets([size(4, 4), size(6, 4), size(6, 4)])).toEqual([
      { x: 0, y: 0, w: 5, h: 4 }, { x: 5, y: 0, w: 7, h: 4 }, { x: 0, y: 4, w: 12, h: 4 },
    ]);
  });

  it("never moves a widget with a grid, nor stretches a row over one", () => {
    expect(placeWidgets([{ grid: { x: 10, y: 0, w: 2, h: 2 }, ...size(3, 2) }, size(4, 2)])).toEqual([
      { x: 10, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 4, h: 2 },
    ]);
  });
});
