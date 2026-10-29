import { describe, expect, it } from "vitest";
import { isTimezoneLocked, parsePreferencesPatch, resolveDisplayPreferences, toUserPreferences } from "./user-preferences.js";

const DISPLAY = { timezone: "UTC", language: "en", regionalFormat: "es-AR" };
const INSTANCE = { ...DISPLAY, userTimezone: true };

describe("resolveDisplayPreferences", () => {
  it("uses the instance defaults when the user chose nothing", () => {
    expect(resolveDisplayPreferences({}, INSTANCE)).toEqual(DISPLAY);
  });

  it("prefers the user's choices", () => {
    expect(resolveDisplayPreferences({ timezone: "Europe/Madrid", regionalFormat: "es-ES", language: "es" }, INSTANCE)).toEqual({
      timezone: "Europe/Madrid",
      language: "es",
      regionalFormat: "es-ES",
    });
  });

  it("takes the user's regional format, else the instance's - else the browser's (empty)", () => {
    expect(resolveDisplayPreferences({ regionalFormat: "en-IN" }, INSTANCE).regionalFormat).toBe("en-IN");
    expect(resolveDisplayPreferences({}, { ...INSTANCE, regionalFormat: "" }).regionalFormat).toBe("");
    expect(resolveDisplayPreferences({}, { ...INSTANCE, regionalFormat: "xx-XX" }).regionalFormat).toBe("");
    expect(toUserPreferences({ regional_format: "xx-XX" })).toEqual({});
    expect(parsePreferencesPatch({ regionalFormat: "ja-JP" })).toEqual({ regionalFormat: "ja-JP" });
    expect(() => parsePreferencesPatch({ regionalFormat: "es" })).toThrow(/regionalFormat must be one of/);
  });

  it("takes the user's language, else the instance's - never one the UI doesn't have", () => {
    expect(resolveDisplayPreferences({ language: "es" }, INSTANCE).language).toBe("es");
    expect(resolveDisplayPreferences({}, { ...INSTANCE, language: "es" }).language).toBe("es");
    expect(resolveDisplayPreferences({}, { ...INSTANCE, language: "xx" }).language).toBe("en");
    expect(toUserPreferences({ language: "xx" })).toEqual({});
    expect(parsePreferencesPatch({ language: "es" })).toEqual({ language: "es" });
    expect(() => parsePreferencesPatch({ language: "fr" })).toThrow(/language must be one of en, es/);
  });
});

describe("isTimezoneLocked", () => {
  it("locks everyone to the instance's zone only when users may not choose and the instance has one", () => {
    expect(isTimezoneLocked({ timezone: "America/Argentina/Buenos_Aires", userTimezone: false })).toBe(true);
    expect(isTimezoneLocked({ timezone: "America/Argentina/Buenos_Aires", userTimezone: true })).toBe(false);
    // No instance zone: the browser decides - nothing to lock to.
    expect(isTimezoneLocked({ timezone: "", userTimezone: false })).toBe(false);
  });

  it("ignores - never drops - a user's own zone while locked", () => {
    const locked = { ...INSTANCE, timezone: "America/Argentina/Buenos_Aires", userTimezone: false };
    expect(resolveDisplayPreferences({ timezone: "Europe/Madrid" }, locked).timezone).toBe("America/Argentina/Buenos_Aires");
    expect(resolveDisplayPreferences({ timezone: "Europe/Madrid" }, { ...locked, userTimezone: true }).timezone).toBe("Europe/Madrid");
  });
});

describe("parsePreferencesPatch", () => {
  it("accepts known keys, trims values and keeps null as 'clear'", () => {
    expect(parsePreferencesPatch({ timezone: " Europe/Madrid ", regionalFormat: null })).toEqual({ timezone: "Europe/Madrid", regionalFormat: null });
  });

  it.each([
    [{ language: "fr" }],
    [{ locale: "es" }],
    [{ dateFormat: "dd/MM/yyyy" }],
    [{ regionalFormat: "es_AR" }],
    [{ regional_format: "es-AR" }],
    [{ timezone: "" }],
    [{ timezone: 5 }],
    [null],
    [["timezone"]],
  ])("rejects %j", (body) => {
    expect(() => parsePreferencesPatch(body)).toThrow();
  });
});

describe("toUserPreferences", () => {
  it("keeps only the known keys", () => {
    expect(toUserPreferences({ timezone: "UTC", extra: 1, time_format: "HH:mm", regional_format: "de-CH" })).toEqual({ timezone: "UTC", regionalFormat: "de-CH" });
    expect(toUserPreferences(null)).toEqual({});
  });
});
