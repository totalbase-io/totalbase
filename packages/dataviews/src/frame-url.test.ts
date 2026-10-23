import { TotalBaseError } from "@totalbase/errors";
import { describe, expect, it } from "vitest";
import { validateFrameUrl, validateFrameUrlTemplate } from "./frame-url.js";

const OWN = "https://totalbase.example.com";

describe("validateFrameUrl (EXTERNALFRAME)", () => {
  it("accepts an https URL and returns it normalized", () => {
    expect(validateFrameUrl("  https://reports.example.com/view?id=7 ", OWN)).toBe("https://reports.example.com/view?id=7");
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["blob:https://example.com/abc"],
    ["http://reports.example.com"],
    ["//reports.example.com"],
    ["reports.example.com"],
    ["https://user:pass@reports.example.com"],
    ["https://user@reports.example.com"],
    [""],
    ["   "],
    [null],
    [42],
  ])("rejects %j", (raw) => {
    expect(() => validateFrameUrl(raw, OWN)).toThrow(TotalBaseError);
    try {
      validateFrameUrl(raw, OWN);
    } catch (error) {
      expect((error as TotalBaseError).code).toBe("DATAVIEW_FRAME_URL_INVALID");
    }
  });

  it("rejects TotalBase's own origin, whatever the path or case", () => {
    for (const raw of ["https://totalbase.example.com/status", "https://TOTALBASE.example.com:443/app", `${OWN}/api/auth/me`]) {
      expect(() => validateFrameUrl(raw, `${OWN}/`)).toThrow(/own pages/);
    }
  });

  it("allows another port or subdomain of the same host (a different origin)", () => {
    expect(validateFrameUrl("https://totalbase.example.com:8443/", OWN)).toBe("https://totalbase.example.com:8443/");
    expect(validateFrameUrl("https://reports.totalbase.example.com/", OWN)).toBe("https://reports.totalbase.example.com/");
  });

  it("rejects an over-long URL", () => {
    expect(() => validateFrameUrl(`https://example.com/${"a".repeat(2048)}`, OWN)).toThrow(/longer than/);
  });
});

describe("validateFrameUrlTemplate", () => {
  it("takes a literal URL, a token after the site, and an empty URL", () => {
    expect(validateFrameUrlTemplate("https://example.com/")).toBe("https://example.com/");
    expect(validateFrameUrlTemplate("https://track.example/s/{{vars.record.data.code}}?l={{ controls.lang.value }}")).toContain("{{vars.record.data.code}}");
    expect(validateFrameUrlTemplate("")).toBe("");
  });

  it("never lets a value choose the site", () => {
    for (const template of [
      "https://{{vars.record.data.host}}/",
      "https://example.com{{vars.record.data.path}}",
      "https://example.com@{{vars.record.data.host}}/",
      "{{vars.record.data.url}}",
      "https://example.com:443/{{vars.record.data.id}}",
    ]) {
      expect(() => validateFrameUrlTemplate(template), template).toThrow();
    }
  });

  it("refuses other tokens, http and the instance's own origin", () => {
    expect(() => validateFrameUrlTemplate("https://example.com/{{codigo}}")).toThrow(/tokens only/);
    expect(() => validateFrameUrlTemplate("http://example.com/{{vars.record.data.id}}")).toThrow(/https/);
    expect(() => validateFrameUrlTemplate("https://tb.example/x/{{vars.record.data.id}}", "https://tb.example")).toThrow(/own pages/);
  });
});
