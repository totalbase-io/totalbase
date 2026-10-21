import { TotalBaseError } from "@totalbase/errors";
import type { ComparisonOperator } from "./operators.js";
import type { IntervalUnit, Period, PeriodBound } from "./variables.js";
import { quoteIdentifier } from "@totalbase/database";

/**
 * Every Postgres-specific SQL-text-generation building block in this
 * package, consolidated into one file - identifier quoting, operator
 * SQL, interval literals, search/pagination clauses, and the mutation
 * RETURNING/ON CONFLICT machinery. Pure reorganization (see the roadmap
 * spec's Phase 7 note): the rest of query-engine (parser, AST,
 * path-resolver's JOIN logic, schema-context) is already dialect-neutral
 * and stays where it is. This is NOT yet a formal multi-engine
 * interface - deliberately: designing one now, with only Postgres to
 * validate its shape against, risks guessing wrong (see the spec's own
 * account of why RETURNING/ON CONFLICT in particular don't reduce to a
 * small swappable fragment). This file exists so that whenever a real
 * second engine is onboarded, the work is "wrap these already-isolated
 * functions behind an interface and write a second implementation," not
 * "first find all the scattered inline SQL."
 */

// --- Identifiers ---------------------------------------------------------

/** Dynamic identifiers must be resolved from trusted catalog metadata before reaching here (AGENTS.md section 7) - quoted by @totalbase/database. */
export { quoteIdentifier };

export function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

// --- Comparison operators -------------------------------------------------

/** SQL fragment for each operator, given a quoted column reference. Value placeholder is "?". */
export const OPERATOR_SQL: Record<ComparisonOperator, string> = {
  _eq: "= ?",
  _neq: "<> ?",
  _gt: "> ?",
  _gte: ">= ?",
  _lt: "< ?",
  _lte: "<= ?",
  _like: "LIKE ?",
  _ilike: "ILIKE ?",
  _regex: "~ ?",
  _in: "= ANY(?)",
  _nin: "<> ALL(?)",
  _between: "BETWEEN ? AND ?",
  _null: "IS NULL",
  _nnull: "IS NOT NULL",
  _contains: "@> ?",
  _contained_by: "<@ ?",
  _overlap: "&& ?",
};

/**
 * `_in`/`_nin` bind their whole value list as a single array parameter
 * (Postgres arrays support this natively) rather than expanding to N
 * placeholders - a different engine without array bind params would
 * need `IN ($1, $2, ...)` instead, a real strategy difference, not just
 * a different string here.
 */
export function inListSql(negate: boolean, valuesParam: string): string {
  return `${negate ? "<> ALL(" : "= ANY("}${valuesParam})`;
}

// --- $INTERVAL.* -----------------------------------------------------------

const INTERVAL_UNIT_NAME: Record<IntervalUnit, string> = {
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days",
  w: "weeks",
  y: "years",
};

/** Compiles a $INTERVAL.* variable to a parameterized "CURRENT_TIMESTAMP - $n * interval '1 x'" fragment. */
export function intervalSql(variable: { amount: number; unit: IntervalUnit }): { sql: string; param: number } {
  return {
    sql: `(CURRENT_TIMESTAMP - (? * interval '1 ${INTERVAL_UNIT_NAME[variable.unit]}'))`,
    param: variable.amount,
  };
}

// --- $PERIOD.* -------------------------------------------------------------

type PeriodUnit = "day" | "week" | "month" | "quarter" | "year";

/** Each period as a calendar unit and how many of them back from the current one. */
const PERIOD_UNITS: Record<Period, { unit: PeriodUnit; back: 0 | 1 }> = {
  today: { unit: "day", back: 0 },
  yesterday: { unit: "day", back: 1 },
  this_week: { unit: "week", back: 0 },
  last_week: { unit: "week", back: 1 },
  this_month: { unit: "month", back: 0 },
  last_month: { unit: "month", back: 1 },
  this_quarter: { unit: "quarter", back: 0 },
  last_quarter: { unit: "quarter", back: 1 },
  this_year: { unit: "year", back: 0 },
  last_year: { unit: "year", back: 1 },
};

/** One unit as a PostgreSQL interval literal - `interval` has no quarter. */
const PERIOD_UNIT_INTERVAL: Record<PeriodUnit, string> = {
  day: "1 day",
  week: "1 week",
  month: "1 month",
  quarter: "3 months",
  year: "1 year",
};

/**
 * Compiles a `$PERIOD.<period>.<from|to>` bound to a `timestamptz`
 * expression PostgreSQL computes itself - `date_trunc` in the session's
 * time zone, so the database decides where "this month" starts (weeks
 * start on Monday, ISO). `from` is inclusive, `to` exclusive. The SQL is
 * built only from the fixed tables above, never from the request: an
 * unknown period is rejected by the parser before it gets here.
 */
export function periodSql(period: Period, bound: PeriodBound): string {
  const { unit, back } = PERIOD_UNITS[period];
  const interval = `interval '${PERIOD_UNIT_INTERVAL[unit]}'`;
  const current = `date_trunc('${unit}', CURRENT_TIMESTAMP)`;
  const from = back === 0 ? current : `(${current} - ${interval})`;
  if (bound === "from") return from;
  return back === 0 ? `(${current} + ${interval})` : current;
}

// --- SELECT: search + pagination -----------------------------------------

/**
 * How `search` (Data_API.md §3.5) compares a text column with one term: both sides through
 * totalbase.search_normalize (lower case, and without accents when `unaccent` is installed),
 * so "perez" finds "Pérez". The parameter is the term as a LIKE pattern (`searchPattern`).
 */
export function searchMatchSql(columnSql: string, patternParam: string): string {
  return `totalbase.search_normalize(${columnSql}) LIKE totalbase.search_normalize(${patternParam})`;
}

/** A search term as a `%term%` LIKE pattern - its own `%`, `_` and `\` are literal, never wildcards. */
export function searchPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function limitOffsetClause(limitParam: string, offsetParam: string): string {
  return ` LIMIT ${limitParam} OFFSET ${offsetParam}`;
}

// --- Value formatting: point -----------------------------------------------

/**
 * The reverse of `packages/database`'s own `point` (OID 600) type parser -
 * that side turns Postgres's `"(x,y)"` text form into `{ lng, lat }` for
 * every read; this is the only place that needs to turn it back into a
 * literal for a write, since node-postgres has no built-in serializer for
 * it either. `x = lng, y = lat`, same convention documented there.
 * Accepts a `[lng, lat]` tuple defensively (JSON.parse of a hand-typed
 * SQL Console/API payload could reasonably produce either shape), but the
 * wire shape widgets/the Data API actually use is the object form.
 */
export function pointLiteral(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let lng: unknown;
  let lat: unknown;
  if (Array.isArray(value) && value.length === 2) {
    [lng, lat] = value;
  } else if (typeof value === "object" && "lng" in value && "lat" in value) {
    ({ lng, lat } = value as { lng: unknown; lat: unknown });
  } else {
    throw new TotalBaseError("INVALID_TYPE", `Expected a point value ({ lng, lat }), got: ${JSON.stringify(value)}`);
  }
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new TotalBaseError("INVALID_TYPE", `Expected a point value ({ lng, lat }) with finite numbers, got: ${JSON.stringify(value)}`);
  }
  return `(${lng},${lat})`;
}

// --- Mutations: RETURNING / ON CONFLICT -----------------------------------

export function onConflictNothingSql(targetSql: string): string {
  return ` ON CONFLICT (${targetSql}) DO NOTHING`;
}

/**
 * `whereSql` (without the WHERE keyword) limits the DO UPDATE branch: the
 * conflicting row is referenced by the INSERT's table alias, the proposed
 * one as EXCLUDED; a conflicting row it rejects is left untouched and the
 * statement returns no row for it.
 */
export function onConflictUpdateSql(targetSql: string, setPartsSql: string[], whereSql?: string): string {
  const where = whereSql ? ` WHERE ${whereSql}` : "";
  return ` ON CONFLICT (${targetSql}) DO UPDATE SET ${setPartsSql.join(", ")}${where}`;
}

/** `$INSERT.<field>` resolves to Postgres's own EXCLUDED.<field> inside an ON CONFLICT DO UPDATE SET clause. */
export function excludedColumnSql(field: string): string {
  return `EXCLUDED.${quoteIdentifier(field)}`;
}

/**
 * `WITH <alias> AS (INSERT ... RETURNING *) SELECT *` - the CTE wrapper
 * that lets the caller (appendAuthorizationFlags) append computed
 * __authorized/__payload_check_N columns evaluated by Postgres itself
 * against the row INSERT actually produced.
 */
export function insertWithReturningCte(
  cteAlias: string,
  intoTable: string,
  columnsSql: string[],
  placeholders: string[],
  onConflictSql: string,
): string {
  // No columns: every column takes its own DEFAULT, PostgreSQL's DEFAULT VALUES.
  const valuesSql = columnsSql.length === 0
    ? "DEFAULT VALUES"
    : `(${columnsSql.join(", ")}) VALUES (${placeholders.join(", ")})`;
  return `WITH ${cteAlias} AS (INSERT INTO ${intoTable} ${valuesSql}${onConflictSql} RETURNING *) SELECT *`;
}

/**
 * insertWithReturningCte for many rows sharing one column set, in one
 * statement. The rows arrive as one jsonb array
 * parameter (`arrayPlaceholder`); each element is turned into the table's
 * own row type with jsonb_populate_record(NULL::table, doc), so every value
 * goes through the column's input conversion exactly as a bound parameter
 * would (an array column from a JSON array, a jsonb column from an object,
 * text/number/bool/timestamp from their JSON form), and only `columnsSql`
 * are inserted - every other column takes its DEFAULT, as in the single-row
 * form. WITH ORDINALITY plus ORDER BY fixes the insertion order to the
 * request's; the INSERT's RETURNING and the CTE scan then emit the rows in
 * that same order (ModifyTable processes its input sequentially - DML is
 * never parallelized - and a CTE's tuplestore is read in the order it was
 * filled). PostgreSQL offers no way to carry the ordinal through
 * RETURNING itself, so this is the strongest ordering available.
 */
export function insertManyWithReturningCte(
  cteAlias: string,
  intoTable: string,
  columnsSql: string[],
  arrayPlaceholder: string,
): string {
  const selected = columnsSql.map((column) => `r.${column}`).join(", ");
  return (
    `WITH ${cteAlias} AS (INSERT INTO ${intoTable} (${columnsSql.join(", ")}) ` +
    `SELECT ${selected} FROM jsonb_array_elements(${arrayPlaceholder}::jsonb) WITH ORDINALITY AS e(doc, ord), ` +
    `LATERAL jsonb_populate_record(NULL::${intoTable}, e.doc) AS r ORDER BY e.ord RETURNING *) SELECT *`
  );
}

/**
 * insertWithReturningCte for `ON CONFLICT ... DO UPDATE`: the INSERT takes
 * `tableAlias` (so the DO UPDATE WHERE can name the conflicting row) and
 * also returns `insertedColumn` - `xmax = 0`, true for a row this statement
 * inserted, false for an existing row its DO UPDATE branch updated.
 *
 * With `locked`, it also returns the conflicting row's values from before
 * the update (`oldColumns`, as aliases): `lockedAlias` selects the row
 * matching the conflict target's values (`locked.whereSql`, against
 * tableAlias) and locks it (FOR UPDATE OF), and the INSERT reads its values
 * through `SELECT ... FROM (SELECT count(*) FROM lockedAlias)` so the lock is
 * taken before the INSERT runs - otherwise the INSERT could update the row
 * first and the locking read would then skip it. The outer select joins the
 * locked row onto the updated one (one input row per statement, so at most
 * one of each). One statement - PostgreSQL 15 has no RETURNING OLD.
 * Without `locked`, the select's FROM is just `cteAlias`.
 */
export function upsertWithReturningCte(
  cteAlias: string,
  lockedAlias: string,
  intoTable: string,
  tableAlias: string,
  columnsSql: string[],
  placeholders: string[],
  onConflictSql: string,
  insertedColumn: string,
  locked?: { whereSql: string; oldColumns: { field: string; column: string }[] },
): { sql: string; fromClause: string } {
  const returning = `RETURNING *, (${tableAlias}.xmax = 0) AS ${insertedColumn}`;
  if (!locked || columnsSql.length === 0) {
    const valuesSql = columnsSql.length === 0
      ? "DEFAULT VALUES"
      : `(${columnsSql.join(", ")}) VALUES (${placeholders.join(", ")})`;
    return {
      sql: `WITH ${cteAlias} AS (INSERT INTO ${intoTable} AS ${tableAlias} ${valuesSql}${onConflictSql} ${returning}) SELECT *`,
      fromClause: ` FROM ${cteAlias}`,
    };
  }
  const selected = locked.oldColumns
    .map(({ field, column }) => `${tableAlias}.${quoteIdentifier(field)} AS ${column}`)
    .join(", ");
  const returned = locked.oldColumns.map(({ column }) => `${lockedAlias}.${column}`).join(", ");
  return {
    sql:
      `WITH ${lockedAlias} AS (SELECT ${selected} FROM ${intoTable} AS ${tableAlias} WHERE ${locked.whereSql} FOR UPDATE OF ${tableAlias}), ` +
      `${cteAlias} AS (INSERT INTO ${intoTable} AS ${tableAlias} (${columnsSql.join(", ")}) ` +
      `SELECT ${placeholders.join(", ")} FROM (SELECT count(*) FROM ${lockedAlias}) AS __locked` +
      `${onConflictSql} ${returning}) SELECT ${cteAlias}.*, ${returned}`,
    fromClause: ` FROM ${cteAlias} LEFT JOIN ${lockedAlias} ON NOT ${cteAlias}.${insertedColumn}`,
  };
}

/**
 * A row's version - PostgreSQL's xmin, the transaction that last wrote it - as text, `__version`: what an
 * optimistic write sends back in If-Match (Data_API.md §5.3, T56).
 */
export const ROW_VERSION_COLUMN = "__version";
export const ROW_VERSION_SQL = (tableAlias: string) => `${tableAlias}.xmin::text AS ${ROW_VERSION_COLUMN}`;

/** Same CTE-with-RETURNING shape as insertWithReturningCte, for UPDATE. */
export function updateWithReturningCte(cteAlias: string, table: string, tableAlias: string, setPartsSql: string[], whereSql: string): string {
  return `WITH ${cteAlias} AS (` + `UPDATE ${table} AS ${tableAlias} ` + `SET ${setPartsSql.join(", ")}${whereSql} RETURNING *, ${ROW_VERSION_SQL(tableAlias)}` + `) SELECT *`;
}

/**
 * updateWithReturningCte, also returning each row's values from before the
 * UPDATE: `lockedAlias` selects the target rows (whereSql, against
 * tableAlias) and locks them (FOR UPDATE OF - only the target, not a
 * relation a row filter's EXISTS reaches), and the UPDATE joins them by
 * primary key, returning the new row plus the locked one's columns as
 * aliases. One statement - PostgreSQL 15 has no RETURNING OLD.
 */
export function updateFromLockedRowsCte(
  cteAlias: string,
  lockedAlias: string,
  table: string,
  tableAlias: string,
  setPartsSql: string[],
  whereSql: string,
  keyColumns: { field: string; column: string }[],
  oldColumns: { field: string; column: string }[],
): string {
  const selected = [...keyColumns, ...oldColumns]
    .map(({ field, column }) => `${tableAlias}.${quoteIdentifier(field)} AS ${column}`)
    .join(", ");
  const join = keyColumns
    .map(({ field, column }) => `${tableAlias}.${quoteIdentifier(field)} = ${lockedAlias}.${column}`)
    .join(" AND ");
  const returned = oldColumns.map(({ column }) => `${lockedAlias}.${column}`).join(", ");
  return (
    `WITH ${lockedAlias} AS (SELECT ${selected} FROM ${table} AS ${tableAlias}${whereSql} FOR UPDATE OF ${tableAlias}), ` +
    `${cteAlias} AS (UPDATE ${table} AS ${tableAlias} SET ${setPartsSql.join(", ")} FROM ${lockedAlias} WHERE ${join} ` +
    `RETURNING ${tableAlias}.*, ${ROW_VERSION_SQL(tableAlias)}, ${returned}) SELECT *`
  );
}

/**
 * updateWithReturningCte, also returning each row's values from before the
 * UPDATE through PostgreSQL 18's RETURNING OLD (`WITH (OLD AS ...)` names
 * it, so a table alias or column named "old" can't shadow it) - one
 * statement, no join, so it needs no primary key. PostgreSQL 18+ only: the
 * caller gates it on the server version.
 */
export function updateReturningOldCte(
  cteAlias: string,
  table: string,
  tableAlias: string,
  setPartsSql: string[],
  whereSql: string,
  oldAlias: string,
  oldColumns: { field: string; column: string }[],
): string {
  const returned = oldColumns.map(({ field, column }) => `${oldAlias}.${quoteIdentifier(field)} AS ${column}`).join(", ");
  return (
    `WITH ${cteAlias} AS (UPDATE ${table} AS ${tableAlias} SET ${setPartsSql.join(", ")}${whereSql} ` +
    `RETURNING WITH (OLD AS ${oldAlias}) ${tableAlias}.*, ${ROW_VERSION_SQL(tableAlias)}, ${returned}) SELECT *`
  );
}

/** DELETE has no authorization flags to append (Security.md §6.6: OLD-only), so no CTE wrapping is needed - a bare RETURNING suffices. */
export function deleteWithReturning(table: string, tableAlias: string, whereSql: string): string {
  return `DELETE FROM ${table} AS ${tableAlias}${whereSql} RETURNING *`;
}
