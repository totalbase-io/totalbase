import { describe, expect, it } from "vitest";
import { looksLikeSettingsTable, suggestSettingsLayout } from "./settings-layout.js";

describe("settings layout", () => {
  it("proposes each slot from the column names, Spanish or English", () => {
    expect(suggestSettingsLayout(["id", "clave", "titulo", "descripcion", "grupo", "orden", "valor", "creado_en"])).toEqual({
      keyColumn: "clave", valueColumn: "valor", titleColumn: "titulo", descriptionColumn: "descripcion", groupColumn: "grupo", orderColumn: "orden",
    });
    expect(suggestSettingsLayout(["key", "value", "label", "help"])).toMatchObject({ keyColumn: "key", valueColumn: "value", titleColumn: "label", descriptionColumn: "help", groupColumn: null });
  });

  it("tells a parameter table by a key and a value", () => {
    expect(looksLikeSettingsTable(["id", "clave", "valor"])).toBe(true);
    expect(looksLikeSettingsTable(["id", "nombre", "precio"])).toBe(false);
  });
});
