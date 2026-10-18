import { TotalBaseError } from "@totalbase/errors";

function isBooleanType(dataType: string): boolean {
  return dataType === "boolean";
}

function isNumericType(dataType: string): boolean {
  return /^(smallint|integer|bigint|numeric|real|double precision|decimal)/.test(dataType);
}

/**
 * Coerces a raw query-string literal to a JS value matching the column's
 * PostgreSQL type, for booleans/numbers. Everything else (text, uuid,
 * dates, timestamps, arrays, jsonb) is passed through as text: PostgreSQL
 * infers the parameter's type from the comparison operand for those
 * (node-postgres sends untyped/"unknown" parameters), which works for the
 * standard comparison and pattern operators used here.
 */
export function coerceLiteral(raw: string, dataType: string): unknown {
  if (isBooleanType(dataType)) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new TotalBaseError("INVALID_TYPE", `Expected boolean, got: ${raw}`);
  }

  if (isNumericType(dataType)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new TotalBaseError("INVALID_TYPE", `Expected number, got: ${raw}`);
    }
    return value;
  }

  return raw;
}
