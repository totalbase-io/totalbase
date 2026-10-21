import { isTimezoneLocked, resolveDisplayPreferences, type DisplayPreferences, type InstanceDisplayDefaults } from "@totalbase/auth";
import type { AppContext } from "./context.js";

/** Settings > General > Date & time - the instance-wide display defaults. */
export async function instanceDisplayDefaults(context: AppContext): Promise<InstanceDisplayDefaults> {
  const [timezone, dateFormat, timeFormat, datetimeFormat, userTimezone, language] = await Promise.all([
    context.settings.get("system.timezone"),
    context.settings.get("system.date_format"),
    context.settings.get("system.time_format"),
    context.settings.get("system.datetime_format"),
    context.settings.get("system.timezone_user_choice"),
    context.settings.get("system.language"),
  ]);
  return { timezone, dateFormat, timeFormat, datetimeFormat, userTimezone, language };
}

/**
 * What the portal formats dates with for this user: their own
 * preferences over the instance defaults (Security.md §4.2).
 * Served with GET /admin/api/auth/me.
 */
export async function effectiveDisplayPreferences(context: AppContext, userId: string): Promise<DisplayPreferences> {
  const [own, instance] = await Promise.all([context.auth.users.getPreferences(userId), instanceDisplayDefaults(context)]);
  return resolveDisplayPreferences(own, instance);
}

/** The zones PostgreSQL knows (pg_timezone_names) - read once; a zone outside it can't be a transaction's TimeZone. */
let knownTimezones: Promise<Set<string>> | null = null;
function timezoneNames(context: AppContext): Promise<Set<string>> {
  knownTimezones ??= context.database
    .query<{ name: string }>("SELECT name FROM pg_timezone_names")
    .then(({ rows }) => new Set(rows.map((r) => r.name)))
    .catch((error: unknown) => {
      knownTimezones = null;
      throw error;
    });
  return knownTimezones;
}

/**
 * The zone a caller works in (Security.md §4.2): their
 * profile's, else the instance's (Settings > General), else - neither set -
 * the browser's, sent as the `X-TotalBase-Timezone` header. The server's own
 * zone never counts. Undefined: none known, PostgreSQL's own applies.
 */
export async function effectiveTimezone(context: AppContext, own: unknown, browserTimezone?: unknown): Promise<string | undefined> {
  const [instance, userTimezone] = await Promise.all([context.settings.get("system.timezone"), context.settings.get("system.timezone_user_choice")]);
  if (typeof own === "string" && own && !isTimezoneLocked({ timezone: instance, userTimezone })) return own;
  if (instance) return instance;
  if (typeof browserTimezone !== "string" || !browserTimezone) return undefined;
  return (await timezoneNames(context)).has(browserTimezone) ? browserTimezone : undefined;
}

/** A user row's own zone - `preferences.timezone`, if they chose one. */
export function ownTimezone(userRow: Record<string, unknown> | undefined): unknown {
  return (userRow?.preferences as { timezone?: unknown } | null | undefined)?.timezone;
}

/** Who runs a dashboard query from an Admin/App API request: its user, in their effective time zone. */
export async function requestViewer(context: AppContext, request: { admin?: { id: string } | null; headers: Record<string, unknown> }): Promise<{ userId: string | null; timezone: string | undefined }> {
  const userId = request.admin?.id ?? null;
  const own = userId ? (await context.auth.users.getPreferences(userId)).timezone : undefined;
  return { userId, timezone: await effectiveTimezone(context, own, request.headers["x-totalbase-timezone"]) };
}
