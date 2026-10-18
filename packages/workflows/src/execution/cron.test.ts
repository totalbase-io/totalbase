import { describe, expect, it } from "vitest";
import { nextOccurrences, parseCronExpression } from "./cron.js";

/** The cron grammar's month and weekday names (Specification_Workflows.md §6.4.2). */
describe("cron names", () => {
  it("reads JAN-DEC and SUN-SAT, case-insensitively, in lists and ranges", () => {
    const schedule = parseCronExpression("0 9 * jan,Jul MON-FRI");
    expect([...schedule.month].sort((a, b) => a - b)).toEqual([1, 7]);
    expect([...schedule.dayOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCronExpression("0 0 * DEC SUN,SAT").dayOfWeek].sort()).toEqual([0, 6]);
    expect([...parseCronExpression("0 0 * MAR-OCT/2 *").month]).toEqual([3, 5, 7, 9]);
  });

  it("matches like the equivalent numbers", () => {
    // Starting close to the occurrences: the preview scan is time-boxed (200 ms).
    const from = new Date("2026-12-31T00:00:00Z");
    expect(nextOccurrences(parseCronExpression("0 3 1 JAN,JUL *"), "UTC", from, 1).map((d) => d.toISOString())).toEqual(["2027-01-01T03:00:00.000Z"]);
    expect(nextOccurrences(parseCronExpression("0 3 1 1,7 *"), "UTC", from, 1).map((d) => d.toISOString())).toEqual(["2027-01-01T03:00:00.000Z"]);
    expect(nextOccurrences(parseCronExpression("30 8 * * MON"), "UTC", new Date("2026-10-03T00:00:00Z"), 1)[0]!.toISOString()).toBe("2026-10-05T08:30:00.000Z");
  });

  it("refuses a name in the wrong field or an unknown name", () => {
    for (const expression of ["0 3 * * JAN", "0 3 * MON *", "0 3 * * FUNDAY", "0 0 * * FRI-MON"]) {
      expect(() => parseCronExpression(expression), expression).toThrow(expect.objectContaining({ code: "WORKFLOW_INVALID_DESIGN" }));
    }
  });
});
