import { describe, expect, it } from "vitest";
import { isTimezoneLocked, parsePreferencesPatch, resolveDisplayPreferences, toUserPreferences } from "./user-preferences.js";

const DISPLAY = { timezone: "UTC", dateFormat: "dd-MM-yyyy", timeFormat: "HH:mm:ss", datetimeFormat: "dd-MM-yyyy HH:mm:ss", language: "en", regionalFormat: "es-AR" };
const INSTANCE = { ...DISPLAY, userTimezone: true };
const EMPTY = { timezone: "", dateFormat: "", timeFormat: "", datetimeFormat: "", userTimezone: true, language: "en", regionalFormat: "" };

describe("resolveDisplayPreferences", () => {
  it("uses the instance defaults when the user chose nothing", () => {
    expect(resolveDisplayPreferences({}, INSTANCE)).toEqual(DISPLAY);
  });

  it("prefers the user's choices, joining date-time from the effective parts", () => {
    expect(resolveDisplayPreferences({ timezone: "Europe/Madrid", timeFormat: "h:mm a" }, INSTANCE)).toEqual({
      timezone: "Europe/Madrid",
      dateFormat: "dd-MM-yyyy",
      timeFormat: "h:mm a",
      datetimeFormat: "dd-MM-yyyy h:mm a",
      language: "en",
      regionalFormat: "es-AR",
    });
  });

  it("takes the regional format from the instance alone - it is not a user preference", () => {
    expect(resolveDisplayPreferences({ language: "es" }, INSTANCE).regionalFormat).toBe("es-AR");
    expect(toUserPreferences({ regional_format: "en-US" })).toEqual({});
    expect(() => parsePreferencesPatch({ regionalFormat: "en-US" })).toThrow();
  });

  it("takes the user's language, else the instance's - never one the UI doesn't have", () => {
    expect(resolveDisplayPreferences({ language: "es" }, INSTANCE).language).toBe("es");
    expect(resolveDisplayPreferences({}, { ...INSTANCE, language: "es" }).language).toBe("es");
    expect(resolveDisplayPreferences({}, { ...INSTANCE, language: "xx" }).language).toBe("en");
    expect(toUserPreferences({ language: "xx" })).toEqual({});
    expect(parsePreferencesPatch({ language: "es" })).toEqual({ language: "es" });
    expect(() => parsePreferencesPatch({ language: "fr" })).toThrow(/language must be one of en, es/);
  });

  it("falls back to plain patterns for a date-time part the instance leaves empty", () => {
    expect(resolveDisplayPreferences({ dateFormat: "dd/MM/yyyy" }, EMPTY)).toEqual({
      timezone: "",
      dateFormat: "dd/MM/yyyy",
      timeFormat: "",
      datetimeFormat: "dd/MM/yyyy HH:mm",
      language: "en",
      regionalFormat: "",
    });
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
    expect(parsePreferencesPatch({ timezone: " Europe/Madrid ", dateFormat: null })).toEqual({ timezone: "Europe/Madrid", dateFormat: null });
  });

  it.each([
    [{ language: "fr" }],
    [{ locale: "es" }],
    [{ dateFormat: "yyyy" }],
    [{ timeFormat: "HH:mm:ss" }],
    [{ date_format: "dd/MM/yyyy" }],
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
    expect(toUserPreferences({ timezone: "UTC", extra: 1, time_format: "HH:mm" })).toEqual({ timezone: "UTC", timeFormat: "HH:mm" });
    expect(toUserPreferences(null)).toEqual({});
  });
});
