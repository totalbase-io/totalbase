import { TotalBaseError } from "@totalbase/errors";
import { DEFAULT_UI_LANGUAGE, isRegionalFormat, isUiLanguage, REGIONAL_FORMATS, UI_LANGUAGES, type RegionalFormat, type UiLanguage } from "@totalbase/shared";

/**
 * A user's own display preferences (`users.preferences`,
 * Security.md §4.2). A missing key means "use the instance default". The
 * column's CHECK holds each key's shape; the lists (UI_LANGUAGES,
 * REGIONAL_FORMATS) are the service's, so adding an entry needs no migration.
 */
export interface UserPreferences {
  timezone?: string;
  /** How numbers, dates and times read (Admin_UI.md §14) - one of REGIONAL_FORMATS. */
  regionalFormat?: RegionalFormat;
  /** The UI's language (Admin_UI.md §14) - one of UI_LANGUAGES. */
  language?: UiLanguage;
}

/** A PATCH: a value sets the key, `null` clears it back to the instance default, absent leaves it alone. */
export type UserPreferencesPatch = { [K in keyof UserPreferences]?: UserPreferences[K] | null };

/** Each preference's key in the stored jsonb - the API speaks camelCase, the column keeps its own keys (and its CHECK names them). */
export const STORED_PREFERENCE_KEYS: Readonly<Record<keyof UserPreferences, string>> = {
  timezone: "timezone",
  regionalFormat: "regional_format",
  language: "language",
};
const PREFERENCE_KEYS = Object.keys(STORED_PREFERENCE_KEYS) as (keyof UserPreferences)[];

/** The instance-wide defaults (Settings > General) - empty = no default. */
export interface InstanceDisplayDefaults {
  timezone: string;
  /** `system.timezone_user_choice` - whether a user's own timezone counts. */
  userTimezone: boolean;
  /** `system.language` - the UI's language for whoever chose none. */
  language: string;
  /** `system.regional_format` - how numbers, dates and times read for whoever chose none; empty = the browser's. */
  regionalFormat: string;
}

/** What the portal formats with. Empty timezone / regional format = the browser's. */
export type DisplayPreferences = Omit<InstanceDisplayDefaults, "userTimezone">;

/**
 * Whether everyone works in the instance's timezone: users may not choose
 * their own, and the instance has one - with none, the lock would leave
 * each viewer's browser deciding, so it doesn't apply. A user's saved
 * choice is kept, just not used, until the lock lifts.
 */
export function isTimezoneLocked(instance: Pick<InstanceDisplayDefaults, "timezone" | "userTimezone">): boolean {
  return !instance.userTimezone && instance.timezone !== "";
}

/** The user's preference, else the instance default. */
export function resolveDisplayPreferences(own: UserPreferences, instance: InstanceDisplayDefaults): DisplayPreferences {
  const timezone = isTimezoneLocked(instance) ? instance.timezone : own.timezone ?? instance.timezone;
  const language = own.language ?? (isUiLanguage(instance.language) ? instance.language : DEFAULT_UI_LANGUAGE);
  const regionalFormat = own.regionalFormat ?? (isRegionalFormat(instance.regionalFormat) ? instance.regionalFormat : "");
  return { timezone, language, regionalFormat };
}

/**
 * Checks a PATCH body's shape: only known keys, each a string (or null).
 * Values are checked against their lists for a readable message; the
 * timezone's existence is checked against PostgreSQL by UsersService.
 */
export function parsePreferencesPatch(body: unknown): UserPreferencesPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TotalBaseError("INVALID_QUERY", "Preferences must be an object.");
  }
  const patch: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(PREFERENCE_KEYS as string[]).includes(key)) {
      throw new TotalBaseError("INVALID_QUERY", `Unknown preference: ${key}.`);
    }
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") throw new TotalBaseError("INVALID_QUERY", `${key} must be text or null.`);
    patch[key] = value === null ? null : value.trim();
  }
  if (typeof patch.timezone === "string" && !patch.timezone) throw new TotalBaseError("INVALID_QUERY", "timezone can't be empty - send null to use the instance default.");
  if (typeof patch.regionalFormat === "string" && !isRegionalFormat(patch.regionalFormat)) {
    throw new TotalBaseError("INVALID_QUERY", `regionalFormat must be one of ${REGIONAL_FORMATS.join(", ")}.`);
  }
  if (typeof patch.language === "string" && !isUiLanguage(patch.language)) {
    throw new TotalBaseError("INVALID_QUERY", `language must be one of ${UI_LANGUAGES.map((l) => l.code).join(", ")}.`);
  }
  return patch as UserPreferencesPatch;
}

/** The stored jsonb (its own snake_case keys), narrowed to the known keys (a developer's writes through the Data API can't smuggle others into the portal). */
export function toUserPreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const result: UserPreferences = {};
  if (typeof source.timezone === "string") result.timezone = source.timezone;
  // A code TotalBase no longer has (a language or a format removed) reads as unset - the instance default.
  if (isRegionalFormat(source.regional_format)) result.regionalFormat = source.regional_format;
  if (isUiLanguage(source.language)) result.language = source.language;
  return result;
}
