import { SQLSTATE_CLASS_ERROR_CODE_MAP, SQLSTATE_ERROR_CODE_MAP } from "./error-codes.js";
import { TotalBaseError } from "./totalbase-error.js";

/** Minimal shape of a `pg` driver error, without a hard dependency on `pg`. */
export interface PostgresDriverError {
  code?: string;
  message: string;
  detail?: string;
  hint?: string;
  /** 1-based character offset into the statement text where PostgreSQL located the error (a syntax error, an unknown column) - a string, as the driver gives it. */
  position?: string;
  /** Which named constraint raised this (CHECK/UNIQUE/FOREIGN KEY violations) - carried on TotalBaseError.constraint; @totalbase/database uses it to look up a friendlier message in the constraint's COMMENT. */
  constraint?: string;
  schema?: string;
  table?: string;
  /** The domain whose CHECK a value violated (no table then: the value failed its cast to the domain). */
  dataType?: string;
  /** The column a NOT NULL violation is about. */
  column?: string;
}

/**
 * Maps a raw PostgreSQL driver error into a TotalBaseError.
 * See Specification_Data_API.md §11.2 (PostgreSQL mappings).
 *
 * Only @totalbase/database should construct raw PostgreSQL errors;
 * every other package receives a TotalBaseError.
 */
export function mapPostgresError(error: PostgresDriverError): TotalBaseError {
  const sqlstate = error.code;
  // The exact SQLSTATE first, then its class (22 data exception, 42 syntax
  // error or access rule violation); anything else is a 500.
  const mappedCode = sqlstate
    ? SQLSTATE_ERROR_CODE_MAP[sqlstate] ?? SQLSTATE_CLASS_ERROR_CODE_MAP[sqlstate.slice(0, 2)]
    : undefined;

  return new TotalBaseError(mappedCode ?? "INTERNAL_ERROR", error.message, {
    source: "POSTGRESQL",
    detail: error.detail,
    hint: error.hint,
    position: parsePosition(error.position),
    sqlstate,
    constraint: error.constraint,
    field: sqlstate === "23502" ? error.column : undefined,
  });
}

function parsePosition(position: string | undefined): number | undefined {
  const value = position === undefined ? Number.NaN : Number.parseInt(position, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
