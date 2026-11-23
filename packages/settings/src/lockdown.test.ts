import { describe, expect, it } from "vitest";
import { lockdownState, lockdownWindowProblem, type LockdownSettings } from "./lockdown.js";

const at = (iso: string) => Date.parse(iso);
const NONE = { active: false, endsAt: null, window: null };

describe("lockdownState", () => {
  const base: LockdownSettings = { enabled: true, when: "NOW", from: "", until: "", recurring: { schedule: "0 3 * * 0", minutes: 60, timeZone: "UTC" } };

  it("is off without its switch, whatever else is set", () => {
    const once = { from: "2026-11-20T02:00:00Z", until: "2026-11-20T03:00:00Z" };
    expect(lockdownState({ ...base, enabled: false }, at("2026-11-20T10:00:00Z"))).toEqual(NONE);
    expect(lockdownState({ ...base, ...once, enabled: false, when: "ONCE" }, at("2026-11-20T02:30:00Z"))).toEqual(NONE);
    expect(lockdownState({ ...base, enabled: false, when: "RECURRING", recurring: { schedule: "* * * * *", minutes: 5, timeZone: "UTC" } }, at("2026-11-20T02:30:00Z"))).toEqual(NONE);
  });

  it("now: on until it is turned off, with no end to announce - a window set for another time doesn't count", () => {
    expect(lockdownState(base, at("2026-11-20T10:00:00Z"))).toEqual({ active: true, endsAt: null, window: null });
    expect(lockdownState({ ...base, from: "2026-11-21T02:00:00Z", until: "2026-11-21T03:00:00Z" }, at("2026-11-20T10:00:00Z"))).toEqual({ active: true, endsAt: null, window: null });
  });

  it("scheduled once: from inclusive, until exclusive, inert once passed", () => {
    const once: LockdownSettings = { ...base, when: "ONCE", from: "2026-11-20T02:00:00Z", until: "2026-11-20T03:00:00Z" };
    const window = { from: at(once.from), until: at(once.until) };
    expect(lockdownState(once, at("2026-11-20T01:59:59Z"))).toEqual({ active: false, endsAt: null, window });
    expect(lockdownState(once, at("2026-11-20T02:00:00Z"))).toEqual({ active: true, endsAt: window.until, window });
    expect(lockdownState(once, at("2026-11-20T03:00:00Z"))).toEqual(NONE);
    // Half a window, or one that ends before it starts, schedules nothing.
    expect(lockdownState({ ...once, until: "" }, at("2026-11-20T02:30:00Z"))).toEqual(NONE);
    expect(lockdownState({ ...once, until: "2026-11-20T01:00:00Z" }, at("2026-11-20T02:30:00Z"))).toEqual(NONE);
  });

  it("repeating: each occurrence of the schedule, in its zone, for its length", () => {
    // Sundays at 03:00 in Buenos Aires (UTC-3), for 90 minutes; 2026-11-22 is a Sunday.
    const weekly: LockdownSettings = { ...base, when: "RECURRING", recurring: { schedule: "0 3 * * 0", minutes: 90, timeZone: "America/Argentina/Buenos_Aires" } };
    const window = { from: at("2026-11-22T06:00:00Z"), until: at("2026-11-22T07:30:00Z") };
    expect(lockdownState(weekly, at("2026-11-20T12:00:00Z"))).toEqual({ active: false, endsAt: null, window });
    expect(lockdownState(weekly, at("2026-11-22T06:00:00Z"))).toEqual({ active: true, endsAt: window.until, window });
    expect(lockdownState(weekly, at("2026-11-22T07:29:59Z"))).toEqual({ active: true, endsAt: window.until, window });
    // Over: the next one is a week later.
    expect(lockdownState(weekly, at("2026-11-22T07:30:00Z"))).toEqual({
      active: false,
      endsAt: null,
      window: { from: at("2026-11-29T06:00:00Z"), until: at("2026-11-29T07:30:00Z") },
    });
    // An expression that no longer reads schedules nothing.
    expect(lockdownState({ ...weekly, recurring: { schedule: "nonsense", minutes: 60, timeZone: "UTC" } }, at("2026-11-22T06:00:00Z"))).toEqual(NONE);
  });
});

describe("lockdownWindowProblem", () => {
  it("wants both ends, the end after the start and still ahead", () => {
    const now = at("2026-11-20T00:00:00Z");
    expect(lockdownWindowProblem("", "", now)).toBeNull();
    expect(lockdownWindowProblem("2026-11-20T02:00:00Z", "2026-11-20T03:00:00Z", now)).toBeNull();
    expect(lockdownWindowProblem("2026-11-20T02:00:00Z", "", now)).not.toBeNull();
    expect(lockdownWindowProblem("2026-11-20T03:00:00Z", "2026-11-20T02:00:00Z", now)).not.toBeNull();
    expect(lockdownWindowProblem("2026-11-19T02:00:00Z", "2026-11-19T03:00:00Z", now)).not.toBeNull();
  });
});
