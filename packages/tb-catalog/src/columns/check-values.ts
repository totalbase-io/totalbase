/**
 * The values a column's CHECK allows, when it is a plain list -
 * `CHECK (status IN ('OPEN', 'CLOSED'))`, which PostgreSQL keeps (and
 * `pg_get_constraintdef` renders) as `(status = ANY (ARRAY['OPEN'::text,
 * 'CLOSED'::text]))`, with a cast around the column and the array for a
 * varchar. A generated form offers them in a select instead of a free
 * input. Anything else - another operator, an OR, a function - is not a
 * list: null, and the column keeps its input.
 */
const LITERAL = String.raw`'(?:[^']|'')*'::[a-z ]+`;
// A number - `21`, `10.5`, `(0)::numeric`, `(-1)::integer` - for a numeric column's list (T61).
const NUMBER = String.raw`\(?-?\d+(?:\.\d+)?\)?(?:::[a-z ]+)?`;
const ELEMENT = `(?:${LITERAL}|${NUMBER})`;
const IN_LIST = new RegExp(
  String.raw`^CHECK \(\(\(?(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))(?:\)::[a-z ]+)? = ANY \(\(?ARRAY\[(${ELEMENT}(?:, ${ELEMENT})*)\](?:\)::[a-z ]+\[\])?\)\)\)$`,
);
const ELEMENTS = new RegExp(`'((?:[^']|'')*)'::[a-z ]+|\\(?(-?\\d+(?:\\.\\d+)?)\\)?(?:::[a-z ]+)?`, "g");

/**
 * Each value as PostgreSQL wrote it: a text list's strings, a numeric list's numbers as text (`"10.5"`, `"21"`) -
 * the record engine turns them into its column's own shape.
 */
export function checkConstraintValues(column: string, expressions: readonly string[]): string[] | null {
  for (const expression of expressions) {
    const match = IN_LIST.exec(expression);
    if (!match) continue;
    const name = match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2];
    if (name !== column) continue;
    return [...match[3]!.matchAll(ELEMENTS)].map((m) => (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]!));
  }
  return null;
}

const ARRAY_LIST = new RegExp(
  String.raw`^CHECK \(\(\(?(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))(?:\)::[a-z ]+\[\])? <@ \(?ARRAY\[(${LITERAL}(?:, ${LITERAL})*)\](?:\)::[a-z ]+\[\])?\)\)$`,
);

/**
 * The values a text[] column's CHECK allows, when it is a plain list - `CHECK (tags <@ ARRAY['a', 'b'])` (Add
 * Column's multiple choice), rendered `(tags <@ ARRAY['a'::text, 'b'::text])` - else null.
 */
export function checkConstraintArrayValues(column: string, expressions: readonly string[]): string[] | null {
  for (const expression of expressions) {
    const match = ARRAY_LIST.exec(expression);
    if (!match) continue;
    const name = match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2];
    if (name !== column) continue;
    return [...match[3]!.matchAll(ELEMENTS)].map((m) => (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]!));
  }
  return null;
}
