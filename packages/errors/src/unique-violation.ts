import type { TotalBaseErrorCode } from "./error-codes.js";
import { TotalBaseError } from "./totalbase-error.js";

/** What a UNIQUE violation on one constraint becomes - the service's own error, named for the user. */
export interface UniqueViolationCase {
  /** The constraint's name, or a suffix of it (a migration's inline UNIQUE gets `<table>_<column>_key`). */
  constraint: string;
  code: TotalBaseErrorCode;
  message: string;
}

/**
 * Rethrows a UNIQUE violation `@totalbase/database` already mapped as the
 * service's own error: the first case whose constraint the violated one
 * matches (equal, or ends with), else `fallback` when given - a table whose
 * other unique column needs no name; any other error passes through
 * unchanged. One helper, so every "a X with this name already exists"
 * reads the same (Pre_Beta_Review 4.6).
 */
export function remapUniqueViolation(error: unknown, cases: UniqueViolationCase[], fallback?: { code: TotalBaseErrorCode; message: string }): never {
  if (error instanceof TotalBaseError && error.code === "UNIQUE_VIOLATION") {
    const constraint = error.constraint ?? "";
    const matched = cases.find((c) => constraint === c.constraint || constraint.endsWith(c.constraint));
    const chosen = matched ?? fallback;
    if (chosen) throw new TotalBaseError(chosen.code, chosen.message);
  }
  throw error;
}
