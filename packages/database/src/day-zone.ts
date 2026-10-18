import { TotalBaseError } from "@totalbase/errors";
import type { Queryable } from "./database.js";

/**
 * The zone a "per day" report buckets timestamps in, as an operand for
 * `AT TIME ZONE` - always bound as a parameter, cast by `cast`.
 */
export interface DayZone {
  cast: "text" | "interval";
  value: string;
  /** What the report says it used: the IANA name, or a fixed offset like "UTC-03:00". */
  label: string;
}

/**
 * The viewer's zone for day buckets: `timeZone` when PostgreSQL knows the
 * name, else the fixed `utcOffsetMinutes` (east of UTC; UTC-3 = -180) - a
 * legacy alias browsers still report (America/Buenos_Aires) is missing
 * from some tz databases.
 */
export async function resolveDayZone(client: Queryable, timeZone: string, utcOffsetMinutes?: number): Promise<DayZone> {
  try {
    await client.query(`SELECT now() AT TIME ZONE $1::text`, [timeZone]);
    return { cast: "text", value: timeZone, label: timeZone };
  } catch {
    const offset = utcOffsetMinutes;
    if (offset === undefined || !Number.isInteger(offset) || Math.abs(offset) > 14 * 60) {
      throw new TotalBaseError("INVALID_QUERY", `Unknown time zone: ${timeZone}`);
    }
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const mm = String(Math.abs(offset) % 60).padStart(2, "0");
    // An interval operand is an ISO offset (positive = east of UTC) -
    // unlike a text '-03:00', which PostgreSQL reads as POSIX (inverted).
    return { cast: "interval", value: `${offset} minutes`, label: `UTC${offset < 0 ? "-" : "+"}${hh}:${mm}` };
  }
}
