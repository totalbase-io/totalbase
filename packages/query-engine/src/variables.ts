import { TotalBaseError } from "@totalbase/errors";
import { isPeriod, PERIODS, type Period, type PeriodBound } from "@totalbase/shared";

/** The period names live in @totalbase/shared (the browser offers them too); this package compiles them. */
export { isPeriod, PERIODS, type Period, type PeriodBound };

/** See Data_API.md §3.7. */
export type IntervalUnit = "s" | "m" | "h" | "d" | "w" | "y";

export type QueryVariable =
  | { kind: "user"; field: string }
  /** `$ROW.<column>` - another column of the same row (Data_API.md §3.7): compared column to column. */
  | { kind: "row"; column: string }
  | { kind: "currentTimestamp" }
  | { kind: "currentDate" }
  | { kind: "currentTime" }
  | { kind: "interval"; amount: number; unit: IntervalUnit }
  | { kind: "period"; period: Period; bound: PeriodBound };

const INTERVAL_PATTERN = /^\$INTERVAL\.(\d+)([smhdwy])$/;
const PERIOD_PATTERN = /^\$PERIOD\.([a-z_]+)\.(from|to)$/;

/** Detects a $-prefixed variable in a raw string value; returns null for plain literals. */
export function parseVariable(raw: string): QueryVariable | null {
  if (raw === "$CURRENT_TIMESTAMP") return { kind: "currentTimestamp" };
  if (raw === "$CURRENT_DATE") return { kind: "currentDate" };
  if (raw === "$CURRENT_TIME") return { kind: "currentTime" };

  if (raw.startsWith("$USER.")) {
    const field = raw.slice("$USER.".length);
    if (!field) {
      throw new TotalBaseError("INVALID_QUERY", "$USER.* requires a field name.");
    }
    return { kind: "user", field };
  }

  if (raw.startsWith("$ROW.")) {
    const column = raw.slice("$ROW.".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new TotalBaseError("INVALID_QUERY", `$ROW.<column> names a column of the same row - not a related one or an expression: ${raw}`);
    }
    return { kind: "row", column };
  }

  if (raw.startsWith("$INTERVAL.")) {
    const match = INTERVAL_PATTERN.exec(raw);
    if (!match) {
      throw new TotalBaseError("INVALID_INTERVAL", `Invalid interval expression: ${raw}`);
    }
    return { kind: "interval", amount: Number(match[1]), unit: match[2] as IntervalUnit };
  }

  if (raw.startsWith("$PERIOD.")) {
    const match = PERIOD_PATTERN.exec(raw);
    if (!match || !isPeriod(match[1]!)) {
      throw new TotalBaseError("INVALID_PERIOD", `Invalid period expression: ${raw}. Expected $PERIOD.<${PERIODS.join("|")}>.<from|to>.`);
    }
    return { kind: "period", period: match[1], bound: match[2] as PeriodBound };
  }

  if (raw.startsWith("$INSERT.")) {
    // $INSERT.* only applies to ON CONFLICT mutations (Phase 4); reject in read queries.
    throw new TotalBaseError("INVALID_QUERY", "$INSERT.* is not valid outside of mutations.");
  }

  return null;
}

// intervalSql()/periodSql() (compiling a parsed interval or period
// variable to SQL) are dialect-sensitive (Postgres's `interval '1 x'` and
// `date_trunc`) and live in pg-dialect.ts - this file only owns the
// neutral parsing of `$INTERVAL.*`/`$PERIOD.*` strings into a QueryVariable.
