import type { FunctionDetail } from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { quoteIdentifier } from "./pg-dialect.js";

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
    params.push(args[parameter.name]);
    argSql.push(`${quoteIdentifier(parameter.name)} => $${params.length}`);
  }

  const callSql = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}(${argSql.join(", ")})`;

  if (detail.returnsRows) {
    return { sql: `SELECT * FROM ${callSql}`, params, scalar: false };
  }
  return { sql: `SELECT ${callSql} AS result`, params, scalar: true };
}
