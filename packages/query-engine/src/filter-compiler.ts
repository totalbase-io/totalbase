import { TotalBaseError } from "@totalbase/errors";
import type { ComparisonNode, FilterNode, RawValue } from "./ast.js";
import { UNARY_OPERATORS } from "./operators.js";
import { inListSql, intervalSql, OPERATOR_SQL, periodSql } from "./pg-dialect.js";

export interface FilterCompileContext {
  /** Resolves a comparison's field path to its SQL column reference + column type. */
  resolveColumn(path: string[]): Promise<{ columnSql: string; dataType: string }>;
  /** Resolves a single raw literal against a known column type. */
  coerceLiteral(raw: string, dataType: string): unknown;
  /** Resolves $USER.<field> against the current principal's totalbase.users row. */
  resolveUserVariable(field: string): unknown;
}

export interface CompiledFragment {
  sql: string;
  params: unknown[];
}

/** What a column compares as - columns of two families never compare (`$ROW`). Null: anything else, left to PostgreSQL. */
function typeFamily(dataType: string | undefined): "number" | "text" | "uuid" | "time" | "boolean" | null {
  const type = (dataType ?? "").toLowerCase();
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision|money)\b/.test(type)) return "number";
  if (/^(text|character varying|character|varchar|char|citext|name)\b/.test(type)) return "text";
  if (type === "uuid") return "uuid";
  if (/^(date|timestamp)\b/.test(type)) return "time";
  if (type === "boolean") return "boolean";
  return null;
}

/** Compiles a FilterNode (where/having AST) into a parameterized SQL fragment. */
export async function compileFilter(
  node: FilterNode,
  context: FilterCompileContext,
  paramOffset: number,
): Promise<CompiledFragment> {
  const params: unknown[] = [];
  let nextIndex = paramOffset;

  const nextParam = (value: unknown): string => {
    nextIndex += 1;
    params.push(value);
    return `$${nextIndex}`;
  };

  /** Resolves one raw value (literal or $variable) into a SQL expression, binding params as needed. */
  async function valueSql(raw: RawValue, dataType: string): Promise<string> {
    if (typeof raw === "string") {
      return nextParam(context.coerceLiteral(raw, dataType));
    }
    switch (raw.kind) {
      // Another column of the same row - resolved as the comparison's own field is (its permissions included);
      // PostgreSQL compares the two, and refuses types it can't.
      case "row": {
        const other = await context.resolveColumn([raw.column]);
        // Two kinds that never compare (a number with a uuid): said plainly, not PostgreSQL's operator error (M28).
        const left = typeFamily(dataType);
        const right = typeFamily(other.dataType);
        if (left && right && left !== right) {
          throw new TotalBaseError("INVALID_QUERY", `$ROW.${raw.column} is ${other.dataType} and the column it is compared with is ${dataType} - $ROW names a column of the same kind (a number with a number, a date with a date).`);
        }
        return other.columnSql;
      }
      case "user":
        return nextParam(context.resolveUserVariable(raw.field));
      case "currentTimestamp":
        return "CURRENT_TIMESTAMP";
      case "currentDate":
        return "CURRENT_DATE";
      case "currentTime":
        return "CURRENT_TIME";
      case "interval": {
        const { sql, param } = intervalSql(raw);
        return sql.replace("?", nextParam(param));
      }
      case "period":
        return periodSql(raw.period, raw.bound);
    }
  }

  async function visit(n: FilterNode): Promise<string> {
    if (n.type === "comparison") {
      return visitComparison(n);
    }
    if (n.type === "and" || n.type === "or") {
      if (n.children.length === 0) return n.type === "and" ? "true" : "false";
      const parts = await Promise.all(n.children.map(visit));
      const joiner = n.type === "and" ? " AND " : " OR ";
      return `(${parts.join(joiner)})`;
    }
    const inner = await Promise.all(n.children.map(visit));
    return `NOT (${inner.join(" AND ")})`;
  }

  async function visitComparison(n: ComparisonNode): Promise<string> {
    const { columnSql, dataType } = await context.resolveColumn(n.path);

    if (UNARY_OPERATORS.has(n.operator)) {
      return `${columnSql} ${OPERATOR_SQL[n.operator]}`;
    }

    if (n.operator === "_in" || n.operator === "_nin") {
      const values = (n.value as RawValue[]).map((v) => resolveLiteralOnly(v, dataType));
      return `${columnSql} ${inListSql(n.operator === "_nin", nextParam(values))}`;
    }

    if (n.operator === "_between") {
      const [low, high] = n.value as RawValue[];
      const lowSql = await valueSql(low!, dataType);
      const highSql = await valueSql(high!, dataType);
      return `${columnSql} BETWEEN ${lowSql} AND ${highSql}`;
    }

    const template = OPERATOR_SQL[n.operator];
    const value = await valueSql(n.value as RawValue, dataType);
    return `${columnSql} ${template.replace("?", value)}`;
  }

  /** _in/_nin/_between arrays are bound as a single array parameter, so variables (CURRENT_* / $INTERVAL / $PERIOD) aren't supported inside them - only literals and $USER.*. */
  function resolveLiteralOnly(raw: RawValue, dataType: string): unknown {
    if (typeof raw === "string") return context.coerceLiteral(raw, dataType);
    if (raw.kind === "user") return context.resolveUserVariable(raw.field);
    throw new TotalBaseError("INVALID_QUERY", `Variable ${raw.kind} is not supported inside _in/_nin.`);
  }

  const sql = await visit(node);
  return { sql, params };
}
