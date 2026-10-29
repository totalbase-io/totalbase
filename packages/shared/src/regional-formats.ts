/**
 * The regional formats a user or an instance may choose (`regional_format`
 * in My account, `system.regional_format`; Admin_UI.md §14): how numbers,
 * dates and times read - separators, grouping, the order of day and month,
 * 12 or 24 hours, the week's first day. A BCP 47 tag (`language-REGION`);
 * the region, not the language: an instance in English may read 1.234,56.
 * Adding one is a line here - the stored preference's CHECK holds only a
 * tag's shape.
 */
export const REGIONAL_FORMATS = [
  "en-US",
  "en-GB",
  "en-CA",
  "en-AU",
  "en-IE",
  "en-IN",
  "en-ZA",
  "es-AR",
  "es-CL",
  "es-CO",
  "es-ES",
  "es-MX",
  "es-PE",
  "es-UY",
  "pt-BR",
  "pt-PT",
  "fr-FR",
  "fr-BE",
  "fr-CA",
  "fr-CH",
  "de-DE",
  "de-AT",
  "de-CH",
  "it-IT",
  "nl-NL",
  "nl-BE",
  "sv-SE",
  "da-DK",
  "nb-NO",
  "fi-FI",
  "pl-PL",
  "cs-CZ",
  "el-GR",
  "tr-TR",
  "ru-RU",
  "uk-UA",
  "he-IL",
  "ja-JP",
  "ko-KR",
  "zh-CN",
] as const;

export type RegionalFormat = (typeof REGIONAL_FORMATS)[number];

export function isRegionalFormat(value: unknown): value is RegionalFormat {
  return typeof value === "string" && (REGIONAL_FORMATS as readonly string[]).includes(value);
}

/**
 * The tag handed to `Intl`: the locale's separators, order and clock, always
 * in Latin digits and the Gregorian calendar - a typed number is digits, a
 * `minus` and one separator, and `$PERIOD` counts Gregorian months. Also for a
 * browser's own locale (th-TH's Buddhist year, ar-EG's digits). Undefined in,
 * undefined out (the runtime's default locale).
 */
export function regionalIntlTag(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  try {
    return new Intl.Locale(locale, { numberingSystem: "latn", calendar: "gregory" }).toString();
  } catch {
    return undefined;
  }
}

/**
 * The hour cycle a locale's times are written in: its own 12-hour clock
 * only when it writes the afternoon "PM" - a date picker (reka's DateField)
 * reads any other day period ("p. m." in es-AR) as the morning, and Chrome
 * drops es-AR's "p. m." from a date and time - else 24 hours.
 */
export function regionalHourCycle(tag: string | undefined): 12 | 24 {
  const format = new Intl.DateTimeFormat(tag, { hour: "numeric" });
  if (format.resolvedOptions().hour12 !== true) return 24;
  const period = format.formatToParts(new Date(2000, 0, 1, 17)).find((part) => part.type === "dayPeriod")?.value;
  return period === "PM" ? 12 : 24;
}

/** `regionalHourCycle` as `Intl` options - spread into a time's own. */
export function regionalClockOptions(tag: string | undefined): Intl.DateTimeFormatOptions {
  return regionalHourCycle(tag) === 24 ? { hourCycle: "h23" } : {};
}

/** What a format looks like - "1.234,56 · 31/12/2026 17:30". */
export function regionalFormatExample(format: string): string {
  const tag = regionalIntlTag(format);
  const number = new Intl.NumberFormat(tag, { minimumFractionDigits: 2 }).format(1234.56);
  const date = new Intl.DateTimeFormat(tag, { timeZone: "UTC" }).format(Date.UTC(2026, 11, 31));
  const time = new Intl.DateTimeFormat(tag, { timeZone: "UTC", hour: "numeric", minute: "2-digit", ...regionalClockOptions(tag) }).format(Date.UTC(2026, 11, 31, 17, 30));
  return `${number} · ${date} ${time}`;
}

/**
 * A picker's label, in `language` (the UI's): the country first, so typing
 * "Argentina" finds it - "Argentina · 1.234,56 · 31/12/2026 17:30"; the
 * language beside a country with more than one ("Switzerland (German)").
 */
export function regionalFormatLabel(format: RegionalFormat, language: string): string {
  const [code, region] = format.split("-") as [string, string];
  const names = (type: "region" | "language") => new Intl.DisplayNames([language, "en"], { type });
  const shared = REGIONAL_FORMATS.filter((f) => f.endsWith(`-${region}`)).length > 1;
  const name = shared ? `${names("region").of(region)} (${names("language").of(code)})` : names("region").of(region);
  return `${name} · ${regionalFormatExample(format)}`;
}
