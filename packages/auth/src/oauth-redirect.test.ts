import { TotalBaseError } from "@totalbase/errors";
import { describe, expect, it } from "vitest";
import { assertRedirectAllowed } from "./oauth-redirect.js";

describe("assertRedirectAllowed", () => {
  it("allows an exact match", () => {
    expect(() =>
      assertRedirectAllowed(["https://app.example.com/callback"], "https://app.example.com/callback"),
    ).not.toThrow();
  });

  it("rejects a URL not in the allowlist", () => {
    expect(() =>
      assertRedirectAllowed(["https://app.example.com/callback"], "https://evil.example.com/callback"),
    ).toThrow(TotalBaseError);
  });

  it("rejects when the allowlist is empty - fails closed", () => {
    expect(() => assertRedirectAllowed([], "https://app.example.com/callback")).toThrow(TotalBaseError);
  });

  it("a '/*' entry matches any URL under that prefix, path and querystring included", () => {
    expect(() =>
      assertRedirectAllowed(["https://app.example.com/*"], "https://app.example.com/auth/callback?x=1"),
    ).not.toThrow();
  });

  it("a '/*' entry does not match a different origin", () => {
    expect(() =>
      assertRedirectAllowed(["https://app.example.com/*"], "https://evil.example.com/app.example.com/callback"),
    ).toThrow(TotalBaseError);
  });

  it("an exact entry does not match a URL with extra path segments", () => {
    expect(() =>
      assertRedirectAllowed(["https://app.example.com/callback"], "https://app.example.com/callback/extra"),
    ).toThrow(TotalBaseError);
  });
});
