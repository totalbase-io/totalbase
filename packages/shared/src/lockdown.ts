/** A lockdown's mode (Security.md §2.21): FULL answers administrators only; READ_ONLY answers everyone's reads and administrators' writes. */
export const LOCKDOWN_MODES = ["FULL", "READ_ONLY"] as const;
export type LockdownMode = (typeof LOCKDOWN_MODES)[number];

/** When an enabled lockdown is on: NOW until it is turned off, ONCE inside its scheduled window, RECURRING inside each occurrence of its schedule. */
export const LOCKDOWN_WHEN = ["NOW", "ONCE", "RECURRING"] as const;
export type LockdownWhen = (typeof LOCKDOWN_WHEN)[number];
