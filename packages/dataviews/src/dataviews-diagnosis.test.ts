import { describe, expect, it } from "vitest";
import { looksLikeSecretColumn } from "./dataviews-diagnosis.js";

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
