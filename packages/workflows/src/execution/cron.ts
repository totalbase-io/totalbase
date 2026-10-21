import { nextOccurrences as nextCron, parseCronExpression as parseCron, wallClockInZone as wallClock, type CronSchedule, type WallClock } from "@totalbase/shared";

// The grammar and its matching live in @totalbase/shared (cron.ts), shared with scheduled backups;
// here, a malformed expression or zone is the workflow's design error (Workflows.md §6.4.2).
export { matchesCron, type CronSchedule, type WallClock } from "@totalbase/shared";

export function parseCronExpression(expr: string): CronSchedule {
  return parseCron(expr, "WORKFLOW_INVALID_DESIGN");
}

export function wallClockInZone(date: Date, timeZone: string): WallClock {
  return wallClock(date, timeZone, "WORKFLOW_INVALID_DESIGN");
}

export function nextOccurrences(schedule: CronSchedule, timeZone: string, from: Date, count: number): Date[] {
  return nextCron(schedule, timeZone, from, count, "WORKFLOW_INVALID_DESIGN");
}

/**
 * What a CRON run's Start receives (Workflows.md §6.4.3),
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
