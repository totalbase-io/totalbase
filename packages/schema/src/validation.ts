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
const DATA_TYPE_PATTERN = /^([A-Za-z_][A-Za-z0-9_ ]*?)\s*(\(\s*\d+\s*(,\s*\d+\s*)?\))?(\s*\[\s*\])?$/;

/**
 * The type names PostgreSQL writes in more than one word. Any other name is one word - a built-in, a domain, an enum -
 * so the words after a type are never a constraint (`integer PRIMARY KEY`) or ALTER TYPE's `USING`.
 */
const MULTI_WORD_TYPES = new Set([
  "character varying", "bit varying", "double precision",
  "time with time zone", "time without time zone", "timestamp with time zone", "timestamp without time zone",
  "interval year", "interval month", "interval day", "interval hour", "interval minute", "interval second",
  "interval year to month", "interval day to hour", "interval day to minute", "interval day to second",
  "interval hour to minute", "interval hour to second", "interval minute to second",
]);

export function validateDataType(dataType: string): void {
  const match = DATA_TYPE_PATTERN.exec(dataType);
  const name = match?.[1]?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  if (dataType.length === 0 || dataType.length > 100 || !match || (name.includes(" ") && !MULTI_WORD_TYPES.has(name))) {
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
  // Any `$tag$`, the tag whatever PostgreSQL takes in one (digits and non-ASCII letters too): a dollar-quoted string
  // hides everything after it from the checks below.
  if (/\$[^$\s]*\$/u.test(expression)) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression must not contain dollar-quoting.`);
  }
  if (FORBIDDEN_TOKENS.test(expression)) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression contains a forbidden keyword.`);
  }
  if (!balancedOutsideQuotes(expression)) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `${kind} expression has unbalanced parentheses or quotes.`);
  }
}

/**
 * Whether an expression's parentheses balance - never closing more than it opened - counting only those outside
 * string literals (`'...'`, `E'...'` with its backslash escapes) and quoted identifiers (`"..."`), every one of which
 * must close. With the expression always placed inside parentheses of its own (`DEFAULT (<expr>)`, `CHECK (<expr>)`,
 * `WHERE (<expr>)`), it then can't end its clause and add another (`0), DISABLE ROW LEVEL SECURITY, ... (0`).
 */
function balancedOutsideQuotes(expression: string): boolean {
  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]!;
    if (char === "'" || char === '"') {
      const escapes = char === "'" && /[eE]/.test(expression[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(expression[i - 2] ?? "");
      let closed = false;
      for (i += 1; i < expression.length; i++) {
        if (escapes && expression[i] === "\\") { i += 1; continue; }
        if (expression[i] === char) {
          if (expression[i + 1] === char) { i += 1; continue; }
          closed = true;
          break;
        }
      }
      if (!closed) return false;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

export const FK_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const;
export type FkAction = (typeof FK_ACTIONS)[number];

export function validateFkAction(action: string, kind: string): FkAction {
  if (!(FK_ACTIONS as readonly string[]).includes(action)) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `Invalid ${kind}: ${action}. Expected one of ${FK_ACTIONS.join(", ")}.`);
  }
  return action as FkAction;
}
