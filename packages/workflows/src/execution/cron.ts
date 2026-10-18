import { TotalBaseError } from "@totalbase/errors";

/**
 * Cron grammar and occurrence matching (specs/Specification_Workflows.md §6.4.2):
 * five whitespace-separated fields (minute, hour, day of
 * month, month, day of week), each accepting a wildcard, a number/name,
 * comma lists, inclusive ranges, and step syntax (wildcard-slash-n or
 * range-slash-n). Deliberately
 * zero-dependency - no cron-parsing library added; the grammar is small
 * enough to parse directly, and DST-correct matching (see `wallClockInZone`
 * below) needs no timezone library either, since `Intl.DateTimeFormat`
 * with an IANA `timeZone` already converts a UTC instant to that zone's
 * wall-clock fields.
 */
export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  dayOfMonthWild: boolean;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfWeekWild: boolean;
}

const MONTH_NAMES: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
/** `0` and `7` both mean Sunday (Specification_Workflows.md §6.4.2) - both map into the same 0-6 index range this expands into. */
const WEEKDAY_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function resolveToken(token: string, names: Record<string, number> | undefined, expr: string): number {
  const named = names?.[token.toUpperCase()];
  if (named !== undefined) return named;
  const n = Number(token);
  if (!Number.isInteger(n)) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Invalid cron field token "${token}" in expression: ${expr}`);
  return n;
}

function expandField(field: string, min: number, max: number, expr: string, names?: Record<string, number>): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!rangePart || !Number.isInteger(step) || step <= 0) {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Invalid cron field "${part}" in expression: ${expr}`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-") as [string, string];
      lo = resolveToken(a, names, expr);
      hi = resolveToken(b, names, expr);
    } else {
      lo = hi = resolveToken(rangePart, names, expr);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Cron field "${part}" out of range [${min}-${max}] in expression: ${expr}`);
    }
    for (let v = lo; v <= hi; v += step) result.add(v);
  }
  return result;
}

export function parseCronExpression(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week): "${expr}"`);
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields as [string, string, string, string, string];
  const dayOfWeekRaw = expandField(dowField, 0, 7, expr, WEEKDAY_NAMES);
  return {
    minute: expandField(minuteField, 0, 59, expr),
    hour: expandField(hourField, 0, 23, expr),
    dayOfMonth: expandField(domField, 1, 31, expr),
    dayOfMonthWild: domField === "*",
    month: expandField(monthField, 1, 12, expr, MONTH_NAMES),
    dayOfWeek: new Set([...dayOfWeekRaw].map((v) => (v === 7 ? 0 : v))),
    dayOfWeekWild: dowField === "*",
  };
}

export interface WallClock {
  minute: number;
  hour: number;
  day: number;
  month: number;
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The IANA zone's own wall-clock reading of a UTC instant - deriving DST
 * behavior by construction rather than by special-casing it: every real
 * UTC instant has exactly one wall-clock reading in a given zone, so a
 * skipped (spring-forward) local time can simply never be produced here,
 * and a repeated (fall-back) local time is correctly produced by two
 * different UTC instants - exactly Specification_Workflows.md §6.4.3's own two rules, with no
 * extra logic needed for either.
 */
function makeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
}

function readWallClock(formatter: Intl.DateTimeFormat, date: Date, timeZone: string): WallClock {
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const weekdayShort = get("weekday");
  const weekday = weekdayShort !== undefined ? WEEKDAY_INDEX[weekdayShort] : undefined;
  const minute = Number(get("minute"));
  const hour = Number(get("hour"));
  const day = Number(get("day"));
  const month = Number(get("month"));
  if (weekday === undefined || [minute, hour, day, month].some(Number.isNaN)) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Invalid IANA timezone: ${timeZone}`);
  }
  return { minute, hour, day, month, weekday };
}

export function wallClockInZone(date: Date, timeZone: string): WallClock {
  return readWallClock(makeZoneFormatter(timeZone), date, timeZone);
}

/** Traditional cron semantics (Specification_Workflows.md §6.4.2): "When both day-of-month and day-of-week are restricted, either match causes the schedule to match." */
export function matchesCron(schedule: CronSchedule, wall: WallClock): boolean {
  if (!schedule.minute.has(wall.minute)) return false;
  if (!schedule.hour.has(wall.hour)) return false;
  if (!schedule.month.has(wall.month)) return false;
  const domMatch = schedule.dayOfMonth.has(wall.day);
  const dowMatch = schedule.dayOfWeek.has(wall.weekday);
  if (schedule.dayOfMonthWild && schedule.dayOfWeekWild) return true;
  if (schedule.dayOfMonthWild) return dowMatch;
  if (schedule.dayOfWeekWild) return domMatch;
  return domMatch || dowMatch;
}

/** Four years of minutes - generous enough to always find a real occurrence (even "Feb 29 on a leap year" recurs within 4 years) while still bounding a brute-force scan against a schedule that can never match (e.g. day-of-month 31 combined with a month that never has one). In practice the wall-clock budget below (`NEXT_OCCURRENCES_MAX_SCAN_MS`) is what actually stops an infeasible schedule's scan - this iteration count is a secondary ceiling, never expected to be reached first. */
const NEXT_OCCURRENCES_MAX_SCAN_MINUTES = 4 * 366 * 24 * 60;
/**
 * Wall-clock budget for the WHOLE scan, checked periodically rather than
 * per iteration (a `Date.now()` call is cheap, but not free at millions of
 * iterations) - the real safeguard against an infeasible schedule (e.g.
 * day-of-month 31 restricted to February, which never occurs) blocking
 * the event loop for the full 4-year iteration ceiling above. Found live
 * while verifying this feature: an early version reused no cached
 * `Intl.DateTimeFormat` AND had no time budget, and a single infeasible-
 * expression request hung the entire dev server's event loop (confirmed -
 * a plain health-check request to an unrelated route stopped responding
 * until the process was killed). Fixed two ways, not just one: the
 * formatter is now built once and reused for the whole scan (below,
 * `makeZoneFormatter`) rather than once per candidate minute, AND this
 * explicit time ceiling bounds worst-case latency regardless of how fast
 * or slow any future change to the per-candidate check turns out to be.
 */
const NEXT_OCCURRENCES_MAX_SCAN_MS = 200;

/**
 * Brute-force minute-by-minute scan for the next `count` UTC instants a
 * schedule matches, starting strictly after `from` - the same matching
 * primitive `cron-dispatcher.ts`'s own live ticker already uses per-minute,
 * just walked forward computationally instead of waiting for real ticks.
 * Used only for an admin-facing "next run" preview (`GET /admin/api/
 * workflows/cron/preview`) - never for actual dispatch, which stays real-
 * time and claim-table-deduplicated in `cron-dispatcher.ts`. Returns
 * fewer than `count` results (possibly zero) rather than throwing if the
 * schedule can't be shown to match anything within the scan budget -
 * an infeasible schedule (day 31 of February) isn't a *malformed*
 * expression, so `WORKFLOW_INVALID_DESIGN` would overstate it; the caller
 * (the admin route) just returns whatever was found, and the UI shows
 * "Next runs: -" for an empty result, same as a schedule not yet computed.
 */
export function nextOccurrences(schedule: CronSchedule, timeZone: string, from: Date, count: number): Date[] {
  const formatter = makeZoneFormatter(timeZone);
  const results: Date[] = [];
  const cursor = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  const deadline = Date.now() + NEXT_OCCURRENCES_MAX_SCAN_MS;
  // Reading a wall clock (Intl) is the cost of the scan. Within one span of
  // 60 minutes whose zone offset does not change (its first and last
  // minutes 59 wall-minutes apart), a candidate's wall minute follows from
  // the first one, so only the minutes the schedule's minute field accepts
  // are read in full; a span with an offset change is read minute by minute.
  for (let i = 0; i < NEXT_OCCURRENCES_MAX_SCAN_MINUTES && results.length < count; i += 60) {
    if (Date.now() > deadline) break;
    const first = readWallClock(formatter, new Date(cursor.getTime() + i * 60_000), timeZone);
    const last = readWallClock(formatter, new Date(cursor.getTime() + (i + 59) * 60_000), timeZone);
    const steady = (first.hour * 60 + first.minute + 59) % (24 * 60) === last.hour * 60 + last.minute;
    for (let m = 0; m < 60 && i + m < NEXT_OCCURRENCES_MAX_SCAN_MINUTES && results.length < count; m++) {
      if (steady && !schedule.minute.has((first.minute + m) % 60)) continue;
      const candidate = new Date(cursor.getTime() + (i + m) * 60_000);
      if (matchesCron(schedule, readWallClock(formatter, candidate, timeZone))) results.push(candidate);
    }
  }
  return results;
}

/**
 * What a CRON run's Start receives (Specification_Workflows.md §6.4.3),
 * read as `{{start.data.scheduled_at}}` etc.: the occurrence it runs for,
 * when it started (UTC ISO-8601 instants) and the configured IANA zone. A
 * run started on demand (editor Run, the run route, Execute workflow) gets
 * the same object with `scheduled_at` = the moment it was requested.
 */
export interface CronStartData {
  scheduled_at: string;
  started_at: string;
  timezone: string | null;
}

export function cronStartData(timezone: unknown, scheduledAt: Date, startedAt: Date = new Date()): CronStartData {
  return {
    scheduled_at: scheduledAt.toISOString(),
    started_at: startedAt.toISOString(),
    timezone: typeof timezone === "string" && timezone ? timezone : null,
  };
}
