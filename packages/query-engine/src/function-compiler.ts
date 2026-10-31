import type { FunctionDetail } from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { quoteIdentifier } from "./pg-dialect.js";

const JSON_TYPES = new Set(["json", "jsonb"]);

export interface CompiledFunctionCall {
  sql: string;
  params: unknown[];
  /** True when the result is a single scalar column ("result"), false when it's a row set (SELECT *). */
  scalar: boolean;
}

/**
 * Compiles a function call using PostgreSQL's named-argument notation
 * (func(param => $1, ...)), which lets Postgres itself reject unknown
 * argument names. See Data_API.md §7.
 */
export function compileFunctionCall(
  schema: string,
  name: string,
  detail: FunctionDetail,
  args: Record<string, unknown>,
): CompiledFunctionCall {
  const params: unknown[] = [];
  const argSql: string[] = [];

  for (const parameter of detail.parameters) {
    if (!(parameter.name in args)) {
      if (parameter.hasDefault) continue; // let PostgreSQL apply its DEFAULT
      throw new TotalBaseError("INVALID_QUERY", `Missing argument: ${parameter.name}`);
    }
    const value = args[parameter.name];
    // A json/jsonb parameter takes any JSON value: serialized here, since the driver would write a list as a
    // PostgreSQL array ({...}) - refused by json, and an empty one read as {} - and cast, so the call is unambiguous.
    const json = JSON_TYPES.has(parameter.dataType);
    params.push(json && value !== null && value !== undefined ? JSON.stringify(value) : value);
    argSql.push(`${quoteIdentifier(parameter.name)} => $${params.length}${json ? `::${parameter.dataType}` : ""}`);
  }

  const callSql = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}(${argSql.join(", ")})`;

  if (detail.returnsRows) {
    return { sql: `SELECT * FROM ${callSql}`, params, scalar: false };
  }
  return { sql: `SELECT ${callSql} AS result`, params, scalar: true };
}
