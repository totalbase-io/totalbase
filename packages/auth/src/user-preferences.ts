import { TotalBaseError } from "@totalbase/errors";
import { DEFAULT_UI_LANGUAGE, isUiLanguage, UI_LANGUAGES, type UiLanguage } from "@totalbase/shared";

/**
 * A user's own display preferences (`users.preferences`,
 * Security.md §4.2). A missing
 * key means "use the instance default". The presets mirror the
 * migration's CHECK constraint - PostgreSQL has the final say; these
 * lists only let the service answer with a readable error first.
 */
export const DATE_FORMAT_PRESETS = ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "dd.MM.yyyy", "d MMM yyyy"] as const;
export const TIME_FORMAT_PRESETS = ["HH:mm", "h:mm a"] as const;

export type DateFormatPreset = (typeof DATE_FORMAT_PRESETS)[number];
export type TimeFormatPreset = (typeof TIME_FORMAT_PRESETS)[number];

export interface UserPreferences {
  timezone?: string;
  dateFormat?: DateFormatPreset;
  timeFormat?: TimeFormatPreset;
  /** The UI's language (Admin_UI.md §14) - one of UI_LANGUAGES. */
  language?: UiLanguage;
}

/** A PATCH: a value sets the key, `null` clears it back to the instance default, absent leaves it alone. */
export type UserPreferencesPatch = { [K in keyof UserPreferences]?: UserPreferences[K] | null };

/** Each preference's key in the stored jsonb - the API speaks camelCase, the column keeps its own keys (and its CHECK names them). */
export const STORED_PREFERENCE_KEYS: Readonly<Record<keyof UserPreferences, string>> = {
  timezone: "timezone",
  dateFormat: "date_format",
  timeFormat: "time_format",
  language: "language",
};
const PREFERENCE_KEYS = Object.keys(STORED_PREFERENCE_KEYS) as (keyof UserPreferences)[];

/** The instance-wide defaults (Settings > General > Date & time) - empty = no default. */
export interface InstanceDisplayDefaults {
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  datetimeFormat: string;
  /** `system.timezone_user_choice` - whether a user's own timezone counts. */
  userTimezone: boolean;
  /** `system.language` - the UI's language for whoever chose none. */
  language: string;
  /** `system.regional_format` - how numbers and browser-formatted dates read; empty = the browser's. Not a user preference. */
  regionalFormat: string;
}

/** What the portal formats with. Empty timezone = the browser's zone; empty pattern = the raw value. */
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

const FALLBACK_DATE = "yyyy-MM-dd";
const FALLBACK_TIME = "HH:mm";

/**
 * The user's preference, else the instance default. Date-time: the
 * instance's own pattern when the user chose neither part; otherwise
 * the two effective parts joined, so a user who picked 12-hour time sees
 * it in date-time values too.
 */
export function resolveDisplayPreferences(own: UserPreferences, instance: InstanceDisplayDefaults): DisplayPreferences {
  const dateFormat = own.dateFormat ?? instance.dateFormat;
  const timeFormat = own.timeFormat ?? instance.timeFormat;
  const datetimeFormat = own.dateFormat === undefined && own.timeFormat === undefined
    ? instance.datetimeFormat
    : `${dateFormat || FALLBACK_DATE} ${timeFormat || FALLBACK_TIME}`;
  const timezone = isTimezoneLocked(instance) ? instance.timezone : own.timezone ?? instance.timezone;
  const language = own.language ?? (isUiLanguage(instance.language) ? instance.language : DEFAULT_UI_LANGUAGE);
  return { timezone, dateFormat, timeFormat, datetimeFormat, language, regionalFormat: instance.regionalFormat };
}

/**
 * Checks a PATCH body's shape: only known keys, each a string (or null).
 * Values are checked against the presets for a readable message; the
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
  if (typeof patch.dateFormat === "string" && !(DATE_FORMAT_PRESETS as readonly string[]).includes(patch.dateFormat)) {
    throw new TotalBaseError("INVALID_QUERY", `dateFormat must be one of ${DATE_FORMAT_PRESETS.join(", ")}.`);
  }
  if (typeof patch.timeFormat === "string" && !(TIME_FORMAT_PRESETS as readonly string[]).includes(patch.timeFormat)) {
    throw new TotalBaseError("INVALID_QUERY", `timeFormat must be one of ${TIME_FORMAT_PRESETS.join(", ")}.`);
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
  if (typeof source.date_format === "string") result.dateFormat = source.date_format as DateFormatPreset;
  if (typeof source.time_format === "string") result.timeFormat = source.time_format as TimeFormatPreset;
  // A code the UI no longer has (a language removed) reads as unset - the instance default.
  if (isUiLanguage(source.language)) result.language = source.language;
  return result;
}
