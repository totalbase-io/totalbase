import { describe, expect, it } from "vitest";
import { looksLikeSecretColumn, styleClassesInCssClass } from "./dataviews-diagnosis.js";

describe("looksLikeSecretColumn", () => {
  it("reads a word of the name, between underscores", () => {
    for (const name of ["token", "access_token", "secreto_certificado", "secreto_clave_privada", "sign", "password", "api_key", "auth", "clave_privada"]) {
      expect(looksLikeSecretColumn(name), name).toBe(true);
    }
  });

  it("leaves a word that only contains one", () => {
    for (const name of ["design", "assignment", "author", "tokenizer_name", "signed_at", "descripcion", "clave"]) {
      expect(looksLikeSecretColumn(name), name).toBe(false);
    }
  });
});

describe("styleClassesInCssClass", () => {
  it("finds the classes the Style tab offers - spacing on any side, alignment, border, radius, background, shadow", () => {
    expect(styleClassesInCssClass("mt-6 text-center")).toEqual(["mt-6", "text-center"]);
    expect(styleClassesInCssClass("p-2.5 mx-4 self-center border rounded-lg bg-muted shadow-md shadow")).toEqual(["p-2.5", "mx-4", "self-center", "border", "rounded-lg", "bg-muted", "shadow-md", "shadow"]);
    expect(styleClassesInCssClass("font-semibold text-lg italic underline text-primary")).toEqual(["font-semibold", "text-lg", "italic", "underline", "text-primary"]);
  });
  it("leaves what Style has no value for - a breakpoint, a state, a width, a font, a color outside the theme's", () => {
    expect(styleClassesInCssClass("md:mt-4 hover:shadow-lg w-full font-mono bg-red-500 text-red-500 truncate uppercase")).toEqual([]);
    expect(styleClassesInCssClass(undefined)).toEqual([]);
    expect(styleClassesInCssClass("")).toEqual([]);
  });
});
