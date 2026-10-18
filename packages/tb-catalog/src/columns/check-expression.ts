import { columnValueKind } from "../widgets/widget-inference.js";

/**
 * A CHECK constraint built from conditions (Resources > a table > Constraints > Add > Build): the admin sends what
 * it built - a column, an operator, a value - and the server turns it into the boolean expression PostgreSQL gets
 * (AGENTS.md §6: the admin never constructs SQL; §7: the server builds the surrounding DDL). The operators are the
 * filter grammar's (Specification_Data_API.md §3), so the one condition builder serves a row filter, a payload
 * check and a real CHECK - but a CHECK has no calling principal: no `$USER.*`, every value a literal.
 */

export const CHECK_CONDITION_OPERATORS = [
  "_eq",
  "_neq",
  "_gt",
  "_gte",
  "_lt",
  "_lte",
  "_like",
  "_ilike",
  "_regex",
  "_in",
  "_nin",
  "_between",
  "_null",
  "_nnull",
  "_contains",
  "_contained_by",
  "_overlap",
] as const;
export type CheckConditionOperator = (typeof CHECK_CONDITION_OPERATORS)[number];

export interface CheckCondition {
  field: string;
  operator: CheckConditionOperator;
  /** Nothing for `_null`/`_nnull`; a [from, to] pair for `_between`; one string otherwise (comma-separated for `_in`/`_nin`, as the grammar's). */
  value?: string | [string, string] | undefined;
}

const OPERATOR_SQL: Record<CheckConditionOperator, string> = {
  _eq: "=",
  _neq: "<>",
  _gt: ">",
  _gte: ">=",
  _lt: "<",
  _lte: "<=",
  _like: "LIKE",
  _ilike: "ILIKE",
  _regex: "~",
  _in: "IN",
  _nin: "NOT IN",
  _between: "BETWEEN",
  _null: "IS NULL",
  _nnull: "IS NOT NULL",
  _contains: "@>",
  _contained_by: "<@",
  _overlap: "&&",
};

const UNARY = new Set<CheckConditionOperator>(["_null", "_nnull"]);
const LIST = new Set<CheckConditionOperator>(["_in", "_nin"]);

export function isCheckConditionOperator(value: unknown): value is CheckConditionOperator {
  return typeof value === "string" && (CHECK_CONDITION_OPERATORS as readonly string[]).includes(value);
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteString(raw: string): string {
  return `'${raw.replace(/'/g, "''")}'`;
}

/** A value as the column's kind writes it: a boolean or a number bare, anything else a quoted string PostgreSQL casts. */
function literal(raw: string, dataType: string): string {
  const kind = columnValueKind(dataType, null);
  if (kind === "boolean") return raw.trim().toLowerCase() === "false" ? "false" : "true";
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) && raw.trim() !== "" ? String(n) : quoteString(raw);
  }
  return quoteString(raw);
}

function conditionSql(condition: CheckCondition, dataType: string): string {
  const column = quoteIdentifier(condition.field);
  const operator = OPERATOR_SQL[condition.operator];
  if (UNARY.has(condition.operator)) return `${column} ${operator}`;
  if (condition.operator === "_between") {
    if (!Array.isArray(condition.value) || condition.value.length !== 2) throw new Error(`${condition.field}: _between needs a [from, to] pair.`);
    const [from, to] = condition.value;
    return `${column} BETWEEN ${literal(from, dataType)} AND ${literal(to, dataType)}`;
  }
  if (typeof condition.value !== "string") throw new Error(`${condition.field}: ${condition.operator} needs a value.`);
  if (LIST.has(condition.operator)) {
    const values = condition.value.split(",").map((v) => literal(v.trim(), dataType));
    return `${column} ${operator} (${values.join(", ")})`;
  }
  return `${column} ${operator} ${literal(condition.value, dataType)}`;
}

/**
 * The boolean expression of a CHECK from its conditions, AND-joined, each parenthesized - over the table's real
 * columns (a condition on a column the table hasn't is refused: the expression names only what the catalog knows).
 * Empty conditions make no expression (""): the caller asks for at least one.
 */
export function buildCheckExpression(conditions: readonly CheckCondition[], columns: readonly { name: string; dataType: string }[]): string {
  const types = new Map(columns.map((c) => [c.name, c.dataType]));
  return conditions
    .map((condition) => {
      const dataType = types.get(condition.field);
      if (dataType === undefined) throw new Error(`Not a column of the table: ${condition.field}`);
      if (!isCheckConditionOperator(condition.operator)) throw new Error(`Unknown operator: ${String(condition.operator)}`);
      return `(${conditionSql(condition, dataType)})`;
    })
    .join(" AND ");
}
