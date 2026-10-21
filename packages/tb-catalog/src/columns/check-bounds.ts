/**
 * The bounds a column's CHECKs hold - a number's (`price >= 0`) and a text's
 * length (`length(code) <= 10`) - so a form shows a value out of range under
 * its field before saving (DataViews.md §15:
 * what values are valid is PostgreSQL's, read live, never copied into a
 * column's presentation). PostgreSQL still decides every save; these only
 * anticipate it, the way `checkConstraintPatterns` anticipates a CHECK's
 * regular expression.
 */

export interface ColumnBound {
  /** `value`: the number itself; `length`: a text's length in characters. */
  kind: "value" | "length";
  op: ">=" | ">" | "<=" | "<";
  value: number;
  /** The constraint's own message (its COMMENT), shown when the value is out of range. */
  message: string | null;
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const LENGTH = /^(?:length|char_length)\((.+)\)$/;
/** A side: a quoted identifier (spaces and all), or a token - with its call's parentheses, `length(c)`. */
const SIDE = String.raw`"(?:[^"]|"")+"|[^\s()"]+(?:\([^()]*\))?`;
const COMPARISON = new RegExp(String.raw`(${SIDE})\s*(>=|<=|>|<)\s*(${SIDE})`, "g");
const FLIPPED: Record<ColumnBound["op"], ColumnBound["op"]> = { ">=": "<=", ">": "<", "<=": ">=", "<": ">" };

/**
 * The bounds on `column` among the CHECKs, as PostgreSQL renders them
 * (`pg_get_constraintdef`): `CHECK (((a >= (0)::numeric) AND (a <= 1000.5)))`,
 * `CHECK ((b > '-5'::integer))`, `CHECK (((0)::numeric < d))`,
 * `CHECK (((length(c) >= 3) AND (length(c) <= 10)))`. Each AND part must
 * hold, so its bound does; a CHECK with an OR, a NOT (but IS NOT NULL) or a
 * CASE is skipped - there a bound alone isn't required.
 */
export function checkConstraintBounds(column: string, constraints: readonly { expression: string; message: string | null }[]): ColumnBound[] {
  const out: ColumnBound[] = [];
  for (const { expression, message } of constraints) {
    const withoutText = expression.replace(/'(?:[^']|'')*'/g, (literal) => (NUMBER.test(literal.slice(1, -1)) ? literal : "''"));
    if (/\b(?:OR|NOT|CASE)\b/.test(withoutText.replace(/\bIS NOT NULL\b/g, ""))) continue;
    for (const match of normalize(expression).matchAll(COMPARISON)) {
      const left = side(match[1]!);
      const right = side(match[3]!);
      const op = match[2] as ColumnBound["op"];
      if (left?.column === column && right?.number !== undefined) out.push({ kind: left.kind, op, value: right.number, message });
      else if (right?.column === column && left?.number !== undefined) out.push({ kind: right.kind, op: FLIPPED[op], value: left.number, message });
    }
  }
  return out;
}

/** Casts gone, quoted and parenthesized numbers bare: `('-2.5'::numeric)::double precision` → `-2.5`. */
function normalize(expression: string): string {
  let out = expression
    .replace(/'(-?\d+(?:\.\d+)?)'/g, "$1")
    .replace(/::[a-z_][a-z0-9_]*(?: [a-z]+)*(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?/g, "");
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\((-?\d+(?:\.\d+)?)\)/g, "$1");
  } while (out !== previous);
  return out;
}

/** One side of a comparison: a number, a column, or a column's length. */
function side(token: string): { number?: number; column?: string; kind: ColumnBound["kind"] } | null {
  if (NUMBER.test(token)) return { number: Number(token), kind: "value" };
  const length = LENGTH.exec(token);
  const name = columnName(length ? length[1]! : token);
  return name ? { column: name, kind: length ? "length" : "value" } : null;
}

function columnName(token: string): string | null {
  const quoted = /^"((?:[^"]|"")+)"$/.exec(token);
  if (quoted) return quoted[1]!.replace(/""/g, '"');
  return /^[a-z_][a-z0-9_$]*$/.test(token) ? token : null;
}

/** Whether `value` (a number, or a text's length) holds `bound`. */
export function holdsBound(bound: ColumnBound, value: number): boolean {
  switch (bound.op) {
    case ">=":
      return value >= bound.value;
    case ">":
      return value > bound.value;
    case "<=":
      return value <= bound.value;
    case "<":
      return value < bound.value;
  }
}

/** A date column's bound from its CHECKs: a day (`'2020-01-01'::date`) or `today` (CURRENT_DATE, now(), CURRENT_TIMESTAMP). */
export interface DateBound {
  op: ">=" | ">" | "<=" | "<";
  /** `YYYY-MM-DD`, or `today` - read on the day the form is used. */
  value: string;
  message: string | null;
}

const DAY = /^'(\d{4}-\d{2}-\d{2})'$/;
const TODAY = /^(?:CURRENT_DATE|CURRENT_TIMESTAMP|now\(\)|LOCALTIMESTAMP|statement_timestamp\(\)|transaction_timestamp\(\))$/i;
const DATE_SIDE = String.raw`"(?:[^"]|"")+"|'\d{4}-\d{2}-\d{2}'|[A-Za-z_][A-Za-z0-9_$]*(?:\(\))?`;
const DATE_COMPARISON = new RegExp(String.raw`(${DATE_SIDE})\s*(>=|<=|>|<)\s*(${DATE_SIDE})`, "g");

/**
 * The bounds on a date or timestamp `column` among the CHECKs, as PostgreSQL renders them:
 * `CHECK ((nacimiento <= CURRENT_DATE))`, `CHECK ((emitida >= '2020-01-01'::date))` - a date picker offers
 * no day past them. Same rule as `checkConstraintBounds`: each AND part, never under an OR, a NOT or a CASE.
 */
export function checkConstraintDateBounds(column: string, constraints: readonly { expression: string; message: string | null }[]): DateBound[] {
  const out: DateBound[] = [];
  for (const { expression, message } of constraints) {
    const withoutText = expression.replace(/'(?:[^']|'')*'/g, "''");
    if (/\b(?:OR|NOT|CASE)\b/.test(withoutText.replace(/\bIS NOT NULL\b/g, ""))) continue;
    // Casts gone: '2020-01-01'::date, CURRENT_DATE::timestamp with time zone, (now())::date.
    const bare = expression.replace(/::[a-z_][a-z0-9_]*(?: [a-z]+)*(?:\(\d+\))?/g, "").replace(/\((now\(\)|CURRENT_DATE|CURRENT_TIMESTAMP|'\d{4}-\d{2}-\d{2}')\)/gi, "$1");
    for (const match of bare.matchAll(DATE_COMPARISON)) {
      const op = match[2] as DateBound["op"];
      const left = match[1]!;
      const right = match[3]!;
      const day = (token: string) => DAY.exec(token)?.[1] ?? (TODAY.test(token) ? "today" : null);
      if (columnName(left) === column && day(right)) out.push({ op, value: day(right)!, message });
      else if (columnName(right) === column && day(left)) out.push({ op: FLIPPED[op], value: day(left)!, message });
    }
  }
  return out;
}
