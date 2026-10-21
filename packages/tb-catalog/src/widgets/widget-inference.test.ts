import { describe, expect, it } from "vitest";
import { compatibleWidgets } from "./widget-compatibility.js";
import { columnFormInput, DEFAULT_WIDGETS } from "../columns/column-inputs.js";
import type { ForeignKeyTarget } from "./widget-inference.js";
import type { ValueKind } from "./widget-catalog.js";

/** A column's default widget: the column input catalog's rule (no chosen input, no CHECKs) - one rule with the form. */
const inferDefaultWidget = (dataType: string, foreignKey: ForeignKeyTarget | null) => columnFormInput({ name: "n", dataType, foreignKey, checks: [] }).widget;

describe("a column's default widget (columnFormInput, DataViews.md §16.1)", () => {
  it("defaults a plain (non-FK) uuid/text column to UInput", () => {
    expect(inferDefaultWidget("uuid", null)).toBe("UInput");
    expect(inferDefaultWidget("text", null)).toBe("UInput");
  });

  it("defaults any other FK to USelectMenu", () => {
    expect(inferDefaultWidget("uuid", { targetSchema: "public", targetTable: "categories" })).toBe("USelectMenu");
  });

  it("defaults a FK targeting totalbase.files to UFileUpload, not USelectMenu (no list route to populate that picker - Administration.md §10)", () => {
    expect(inferDefaultWidget("uuid", { targetSchema: "totalbase", targetTable: "files" })).toBe("UFileUpload");
  });

  it("does not confuse a files-named table with the real totalbase.files", () => {
    expect(inferDefaultWidget("uuid", { targetSchema: "public", targetTable: "files" })).toBe("USelectMenu");
  });

  it("defaults json/jsonb to TJson", () => {
    expect(inferDefaultWidget("json", null)).toBe("TJson");
    expect(inferDefaultWidget("jsonb", null)).toBe("TJson");
  });

  it("defaults a date, a time and a timestamp to their pickers", () => {
    expect(inferDefaultWidget("date", null)).toBe("UInputDate");
    expect(inferDefaultWidget("time without time zone", null)).toBe("UInputTime");
    expect(inferDefaultWidget("timestamp with time zone", null)).toBe("UInputDate");
  });

  it("defaults point to the map - UInput is broken here, not just a plain fallback", () => {
    expect(inferDefaultWidget("point", null)).toBe("TLeafletMap");
  });

  it("edits a range with its from and to (T2) - a multirange stays text", () => {
    for (const type of ["int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange"]) expect(inferDefaultWidget(type, null)).toBe("TRangeInput");
    expect(inferDefaultWidget("datemultirange", null)).toBe("UInput");
  });

  it("defaults every value kind to one of its own compatible widgets", () => {
    const samples: Record<Exclude<ValueKind, "date_range" | "time_range">, [string, { targetSchema: string; targetTable: string } | null]> = {
      text: ["text", null],
      number: ["integer", null],
      boolean: ["boolean", null],
      date: ["date", null],
      time: ["time without time zone", null],
      timestamp: ["timestamp with time zone", null],
      json: ["jsonb", null],
      point: ["point", null],
      range: ["tstzrange", null],
      array: ["text[]", null],
      relation: ["uuid", { targetSchema: "public", targetTable: "categories" }],
      file: ["uuid", { targetSchema: "totalbase", targetTable: "files" }],
    };
    for (const [kind, [dataType, fk]] of Object.entries(samples)) {
      expect(compatibleWidgets(dataType, fk)).toContain(DEFAULT_WIDGETS[kind as ValueKind]);
    }
  });
});
