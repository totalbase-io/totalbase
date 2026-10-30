import { describe, expect, it } from "vitest";
import { compatibleWidgets } from "./widget-compatibility.js";

describe("compatibleWidgets()", () => {
  it("offers the file widgets - upload first - for a FK targeting totalbase.files", () => {
    expect(compatibleWidgets("uuid", { targetSchema: "totalbase", targetTable: "files" })).toEqual(["UFileUpload", "TCamera", "TSignature"]);
  });

  it("offers USelect/USelectMenu for any other FK", () => {
    expect(compatibleWidgets("uuid", { targetSchema: "public", targetTable: "categories" })).toEqual(["USelect", "USelectMenu"]);
  });

  it("offers array-shaped widgets for an array column", () => {
    expect(compatibleWidgets("text[]", null)).toEqual(["UInputTags", "UCheckboxGroup"]);
  });

  it("offers boolean-shaped widgets for boolean", () => {
    expect(compatibleWidgets("boolean", null)).toEqual(["USwitch", "UCheckbox"]);
  });

  it("offers numeric widgets for every numeric type", () => {
    for (const type of ["integer", "bigint", "smallint", "numeric", "real", "double precision", "decimal", "money"]) {
      expect(compatibleWidgets(type, null)).toEqual(["UInput", "UInputNumber", "USlider", "UInputRating"]);
    }
  });

  it("offers UInputDate for a date and a timestamp - the admin's adapter keeps a timestamp's time", () => {
    expect(compatibleWidgets("date", null)).toEqual(["UInput", "UInputDate"]);
    expect(compatibleWidgets("timestamp without time zone", null)).toEqual(["UInput", "UInputDate"]);
    expect(compatibleWidgets("timestamp with time zone", null)).toEqual(["UInput", "UInputDate"]);
  });

  it("offers TJson, UTextarea and UEditor for json/jsonb", () => {
    expect(compatibleWidgets("jsonb", null)).toEqual(["UTextarea", "UEditor", "TJson"]);
  });

  it("offers UInputTime for a time column, distinct from timestamp", () => {
    expect(compatibleWidgets("time without time zone", null)).toEqual(["UInput", "UInputTime"]);
  });

  it("falls back to the full text-ish widget set, including UPinInput/UEditor, for text/varchar/uuid", () => {
    const expected = ["UInput", "UTextarea", "USelect", "USelectMenu", "UInputMenu", "URadioGroup", "UListbox", "UPinInput", "TScanner", "UEditor", "TColorSelect", "TUuidInput", "TUlidInput", "TPasswordInput"];
    expect(compatibleWidgets("text", null)).toEqual(expected);
    expect(compatibleWidgets("uuid", null)).toEqual(expected);
  });

  it("offers only the map for a point column - a plain UInput would be broken, not just suboptimal", () => {
    expect(compatibleWidgets("point", null)).toEqual(["TLeafletMap", "TGeolocation"]);
  });
});
