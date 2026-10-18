/**
 * The languages the UI is translated into (Specification_Admin_UI.md §14) -
 * one list for the server (a user's `language` preference, the instance's
 * `system.language`) and the admin (its locale files, the language
 * pickers). Adding a language is a line here and its locale file in
 * apps/admin/i18n/locales/. English is the default and the source: every
 * text exists in it.
 */
export const UI_LANGUAGES = [
  { code: "en", name: "English", bcp47: "en-US" },
  { code: "es", name: "Español", bcp47: "es" },
] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number]["code"];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && UI_LANGUAGES.some((language) => language.code === value);
}
