/**
 * Which step of Security.md §4.2's precedence gave a caller's effective time
 * zone: their own preference, the instance's (Settings › General), the
 * browser's (`X-TotalBase-Timezone`), or none of them - PostgreSQL's own zone
 * ran. A dashboard run says so in `meta.timezone` (Dashboards.md §2.3).
 */
export const TIMEZONE_SOURCES = ["USER", "INSTANCE", "BROWSER", "POSTGRESQL"] as const;
export type TimezoneSource = (typeof TIMEZONE_SOURCES)[number];

/** The zone a run used, as a response's `meta.timezone` carries it - `name` null when PostgreSQL's own applied. */
export interface RunTimezone {
  name: string | null;
  source: TimezoneSource;
}
