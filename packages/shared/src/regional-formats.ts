/**
 * The regional formats an instance may set (`system.regional_format`,
 * Admin_UI.md §14): how numbers and browser-formatted dates read -
 * separators, grouping, the order of day and month. A BCP 47 tag, handed
 * to `Intl` as is; the region, not the language: an instance in English may
 * read 1.234,56. Empty = each viewer's browser. Adding one is a line here.
 */
export const REGIONAL_FORMATS = [
  "en-US",
  "en-GB",
  "es-AR",
  "es-ES",
  "es-MX",
  "pt-BR",
  "de-DE",
  "de-CH",
  "fr-FR",
  "it-IT",
  "sv-SE",
] as const;

export type RegionalFormat = (typeof REGIONAL_FORMATS)[number];

export function isRegionalFormat(value: unknown): value is RegionalFormat {
  return typeof value === "string" && (REGIONAL_FORMATS as readonly string[]).includes(value);
}

/** What a format looks like - "1.234,56 · 31/12/2026" - for a picker's label. */
export function regionalFormatExample(format: RegionalFormat): string {
  const number = new Intl.NumberFormat(format, { minimumFractionDigits: 2 }).format(1234.56);
  const date = new Intl.DateTimeFormat(format, { timeZone: "UTC" }).format(Date.UTC(2026, 11, 31));
  return `${number} · ${date}`;
}
