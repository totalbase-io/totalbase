import { TotalBaseError } from "@totalbase/errors";
import { quoteIdentifier } from "@totalbase/database";

/**
 * DDL for this package is built by string concatenation - PostgreSQL has
 * no way to parameterize identifiers or DDL fragments. The structural
 * defense is that @totalbase/database's `query()` always passes a
 * `values` array (defaulting to `[]`), which forces `pg`'s extended
 * query protocol; PostgreSQL's extended protocol rejects more than one
 * statement per call outright, so a `;`-stacked statement can never
 * execute even if it slipped past validation. Everything below is
 * defense-in-depth on top of that guarantee, and gives a clean 400
 * instead of a raw protocol error (Administration.md §3.9:
 * "reject attempts to escape into multiple SQL statements or arbitrary
 * DDL/DML").
 */

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** PostgreSQL's NAMEDATALEN default (64) leaves 63 usable characters. */
const MAX_IDENTIFIER_LENGTH = 63;

export function validateIdentifier(name: string, kind: string): void {
  if (name.length === 0 || name.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(name)) {
    throw new TotalBaseError(
      "INVALID_SCHEMA_OPERATION",
      `Invalid ${kind} name: "${name}". Must start with a letter or underscore, contain only letters/digits/underscores, and be at most ${MAX_IDENTIFIER_LENGTH} characters.`,
    );
  }
}

/** Quoted by @totalbase/database - the one implementation (AGENTS.md section 7). */
export { quoteIdentifier };

/** e.g. "numeric(12,2)", "character varying(255)", "text[]", "timestamptz". */
const DATA_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?(\s*\[\s*\])?$/;

export function validateDataType(dataType: string): void {
  if (dataType.length === 0 || dataType.length > 100 || !DATA_TYPE_PATTERN.test(dataType)) {
    throw new TotalBaseError(
      "INVALID_SCHEMA_OPERATION",
      `Invalid data type: "${dataType}". Expected a plain PostgreSQL type name, optionally with (precision[,scale]) or [] - no expressions.`,
    );
  }
}

const FORBIDDEN_TOKENS =
  /\b(DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|INSERT|UPDATE|DELETE|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|SET|RESET|LISTEN|NOTIFY|PREPARE|DEALLOCATE|EXECUTE)\b/i;

/**
 * Validates a raw SQL expression fragment (CHECK expression or column
 * DEFAULT) that gets concatenated directly into DDL text. Rejects the
 * stacked-statement and comment-based escape patterns explicitly called
 * out by Administration.md §3.2, plus DDL/DML keywords a legitimate boolean/value
 * expression would never need.
 */
export function validateSqlExpression(expression: string, kind: string): void {
  if (expression.length === 0 || expression.length > 2000) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression must be 1-2000 characters.`);
  }
  if (expression.includes(";")) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression must not contain ";".`);
  }
  if (expression.includes("--") || expression.includes("/*") || expression.includes("*/")) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression must not contain SQL comments.`);
  }
  if (expression.includes("$$")) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression must not contain dollar-quoting.`);
  }
  if (FORBIDDEN_TOKENS.test(expression)) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression contains a forbidden keyword.`);
  }
  let depth = 0;
  for (const char of expression) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression has unbalanced parentheses.`);
  }
}

export const FK_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const;
export type FkAction = (typeof FK_ACTIONS)[number];

export function validateFkAction(action: string, kind: string): FkAction {
  if (!(FK_ACTIONS as readonly string[]).includes(action)) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `Invalid ${kind}: ${action}. Expected one of ${FK_ACTIONS.join(", ")}.`);
  }
  return action as FkAction;
}
