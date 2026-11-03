import { isTimezoneLocked, resolveDisplayPreferences, type DisplayPreferences, type InstanceDisplayDefaults } from "@totalbase/auth";
import { timezoneNames } from "@totalbase/database";
import type { RunTimezone, TimezoneSource } from "@totalbase/shared";
import type { AppContext } from "./context.js";

/** Settings > General > Language and Date & time - the instance-wide display defaults. */
export async function instanceDisplayDefaults(context: AppContext): Promise<InstanceDisplayDefaults> {
  const [timezone, userTimezone, language, regionalFormat] = await Promise.all([
    context.settings.get("system.timezone"),
    context.settings.get("system.timezone_user_choice"),
    context.settings.get("system.language"),
    context.settings.get("system.regional_format"),
  ]);
  return { timezone, userTimezone, language, regionalFormat };
}

/**
 * What the portal formats dates and numbers with for this user: their own
 * preferences over the instance defaults (Security.md §4.2).
 * Served with GET /admin/api/auth/me.
 */
export async function effectiveDisplayPreferences(context: AppContext, userId: string): Promise<DisplayPreferences> {
  const [own, instance] = await Promise.all([context.auth.users.getPreferences(userId), instanceDisplayDefaults(context)]);
  return resolveDisplayPreferences(own, instance);
}

/** A caller's effective zone and which step of the precedence gave it. */
export interface ResolvedTimezone {
  /** PostgreSQL's name for it - undefined: none known, PostgreSQL's own applies. */
  name: string | undefined;
  source: TimezoneSource;
}

/**
 * The zone a caller works in (Security.md §4.2): their
 * profile's, else the instance's (Settings > General), else - neither set -
 * the browser's, sent as the `X-TotalBase-Timezone` header. The server's own
 * zone never counts. Each name is taken as PostgreSQL knows it
 * (`timezoneNames`): a browser's ICU spelling (`America/Buenos_Aires`) stands
 * for the zone PostgreSQL names `America/Argentina/Buenos_Aires`; a name
 * PostgreSQL can't resolve at all is skipped, and the answer says so
 * (`source: "POSTGRESQL"`) instead of failing in silence.
 */
export async function resolveTimezone(context: AppContext, own: unknown, browserTimezone?: unknown): Promise<ResolvedTimezone> {
  const [instance, userTimezone, names] = await Promise.all([
    context.settings.get("system.timezone"),
    context.settings.get("system.timezone_user_choice"),
    timezoneNames(context.database),
  ]);
  const ownName = isTimezoneLocked({ timezone: instance, userTimezone }) ? undefined : names.canonical(own);
  if (ownName) return { name: ownName, source: "USER" };
  const instanceName = names.canonical(instance);
  if (instanceName) return { name: instanceName, source: "INSTANCE" };
  const browserName = names.canonical(browserTimezone);
  if (browserName) return { name: browserName, source: "BROWSER" };
  return { name: undefined, source: "POSTGRESQL" };
}

/** `resolveTimezone`'s name alone - what a transaction's `TimeZone` is set to. */
export async function effectiveTimezone(context: AppContext, own: unknown, browserTimezone?: unknown): Promise<string | undefined> {
  return (await resolveTimezone(context, own, browserTimezone)).name;
}

/** A user row's own zone - `preferences.timezone`, if they chose one. */
export function ownTimezone(userRow: Record<string, unknown> | undefined): unknown {
  return (userRow?.preferences as { timezone?: unknown } | null | undefined)?.timezone;
}

/** Who runs a dashboard query from an Admin/App API request: its user, in their effective time zone. */
export async function requestViewer(
  context: AppContext,
  request: { admin?: { id: string } | null; headers: Record<string, unknown> },
): Promise<{ userId: string | null; timezone: string | undefined; timezoneSource: TimezoneSource }> {
  const userId = request.admin?.id ?? null;
  const own = userId ? (await context.auth.users.getPreferences(userId)).timezone : undefined;
  const zone = await resolveTimezone(context, own, request.headers["x-totalbase-timezone"]);
  return { userId, timezone: zone.name, timezoneSource: zone.source };
}

/** The zone a dashboard run used, as its response's `meta.timezone` says it (Dashboards.md §2.3). */
export function runTimezone(viewer: { timezone?: string | undefined; timezoneSource?: TimezoneSource | undefined }): RunTimezone {
  return { name: viewer.timezone ?? null, source: viewer.timezoneSource ?? (viewer.timezone ? "INSTANCE" : "POSTGRESQL") };
}
