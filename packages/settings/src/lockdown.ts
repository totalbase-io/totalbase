import { nextOccurrences, parseCronExpression, type LockdownWhen } from "@totalbase/shared";

/**
 * Lockdown (Security.md §2.21): whether the instance answers administrators only, from its settings. Pure - the
 * state is computed on each ask, never stored: a scheduled window starts and ends by the clock alone.
 */

/** An ISO 8601 instant with its offset (`2026-11-20T02:00:00Z`, `...-03:00`) - what `lockdown.from`/`lockdown.until` hold. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The instant's epoch milliseconds, or null when the text is empty or not an instant. */
export function parseLockdownInstant(value: string): number | null {
  if (!INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** A problem with one end of the window, or null - a setting validator. */
export function validateLockdownInstant(value: unknown): string | null {
  return value === "" || parseLockdownInstant(value as string) !== null ? null : "Expected a date and time with its offset (2026-11-20T02:00:00Z), or empty.";
}

/** A problem with the window as a whole, or null: both ends or neither, the end after the start and still ahead. */
export function lockdownWindowProblem(from: string, until: string, now: number): string | null {
  if (from === "" && until === "") return null;
  const start = parseLockdownInstant(from);
  const end = parseLockdownInstant(until);
  if (start === null || end === null) return "A scheduled lockdown needs both its start and its end.";
  if (end <= start) return "A scheduled lockdown ends after it starts.";
  if (end <= now) return "A scheduled lockdown ends in the future.";
  return null;
}

export interface LockdownSettings {
  /** The switch: off, there is no lockdown. */
  enabled: boolean;
  /** When an enabled lockdown is on. */
  when: LockdownWhen;
  /** ONCE: the window's two ends. */
  from: string;
  until: string;
  /** RECURRING: the cron expression, how long each occurrence lasts and the zone the expression is read in. */
  recurring: { schedule: string; minutes: number; timeZone: string };
}

export interface LockdownWindow {
  from: number;
  until: number;
}

export interface LockdownState {
  /** Only administrators are answered right now. */
  active: boolean;
  /** When it ends by itself (epoch ms) - a running window; null when it is on until turned off, or when inactive. */
  endsAt: number | null;
  /** The scheduled window running now, else the next one ahead - scheduled once or repeating; null when there is none. */
  window: LockdownWindow | null;
}

// The last one-off window parsed: its two texts change only when an administrator edits them, and this runs on every request.
let parsed: { from: string; until: string; window: LockdownWindow | null } | null = null;

function onceWindow(from: string, until: string, now: number): LockdownWindow | null {
  if (parsed?.from !== from || parsed.until !== until) {
    const start = parseLockdownInstant(from);
    const end = parseLockdownInstant(until);
    parsed = { from, until, window: start !== null && end !== null && end > start ? { from: start, until: end } : null };
  }
  return parsed.window && now < parsed.window.until ? parsed.window : null;
}

// The repeating window last found. Finding an occurrence scans the calendar, so it is kept for as long as it is
// the answer: until that occurrence's window has ended (or, with none found, for an hour).
let repeated: { key: string; computedAt: number; validUntil: number; window: LockdownWindow | null } | null = null;

/**
 * The repeating window at `now`: the occurrence whose window is running, else the next one. An occurrence at `s`
 * runs over [s, s + minutes) - so the first occurrence after `now - minutes` is the one running, or the next ahead.
 */
function repeatingWindow(recurring: LockdownSettings["recurring"], now: number): LockdownWindow | null {
  const key = `${recurring.schedule}\n${recurring.minutes}\n${recurring.timeZone}`;
  if (repeated?.key !== key || now < repeated.computedAt || now >= repeated.validUntil) {
    const length = recurring.minutes * 60_000;
    let window: LockdownWindow | null = null;
    try {
      const start = nextOccurrences(parseCronExpression(recurring.schedule), recurring.timeZone, new Date(now - length + 1), 1)[0];
      if (start) window = { from: start.getTime(), until: start.getTime() + length };
    } catch {
      // An expression or a zone that no longer reads schedules nothing.
    }
    repeated = { key, computedAt: now, validUntil: window ? window.until : now + 3_600_000, window };
  }
  return repeated.window;
}

/** The state at `now`: off without its switch; with it, on NOW, or inside its window (`from` inclusive, `until` exclusive). */
export function lockdownState(settings: LockdownSettings, now: number): LockdownState {
  if (!settings.enabled) return { active: false, endsAt: null, window: null };
  if (settings.when === "NOW") return { active: true, endsAt: null, window: null };
  const window = settings.when === "ONCE" ? onceWindow(settings.from, settings.until, now) : repeatingWindow(settings.recurring, now);
  const running = window !== null && now >= window.from;
  return { active: running, endsAt: running ? window.until : null, window };
}
