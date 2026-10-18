/**
 * Calendar periods (Specification_Data_API.md §3.7) - the query language's
 * `$PERIOD.<period>.<from|to>` and a date range variable's presets. Only the
 * names live here, so the browser can offer them; PostgreSQL computes the
 * bounds (@totalbase/query-engine's periodSql).
 */
export const PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
] as const;
export type Period = (typeof PERIODS)[number];
export type PeriodBound = "from" | "to";

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}
