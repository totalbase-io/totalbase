/**
 * Regular expressions a form checks a text value against before saving -
 * so a wrong value shows under its field instead of after a round trip.
 * PostgreSQL still decides every save; these only anticipate it.
 *
 * Two sources:
 * - the author's Pattern on a form field: JavaScript syntax, matching the
 *   whole value, like HTML's `pattern` attribute;
 * - the column's own CHECK (`col ~ '...'`, `col ~* '...'`), read from the
 *   database. PostgreSQL's regex dialect (ARE) and JavaScript's agree on
 *   the common syntax but not on all of it - `[[:alpha:]]` compiles in
 *   JavaScript and means something else, `\m`/`\y` don't exist there - so
 *   only a pattern written entirely in syntax that means the same in both
 *   is taken. Anything else is left to PostgreSQL: a form that rejects
 *   valid values would be worse than one that waits for the save.
 */

/** A pattern from a column's CHECK, ready for `new RegExp(source, flags)`. */
export interface ColumnPattern {
  source: string;
  flags: string;
  /** The constraint's own message (its COMMENT), shown when the value doesn't match. */
  message: string | null;
}

/** The author's Pattern as a RegExp matching the whole value, or null when it doesn't compile. */
export function authorPattern(source: string): RegExp | null {
  try {
    return new RegExp(`^(?:${source})$`, "u");
  } catch {
    return null;
  }
}

const COLUMN = String.raw`\(*(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))(?:\)::[a-z ]+)?`;
const MATCH = new RegExp(String.raw`${COLUMN} (~\*?) '((?:[^']|'')*)'::text`, "g");

/**
 * The patterns a column's CHECKs hold, as PostgreSQL renders them
 * (`pg_get_constraintdef`): `CHECK ((cae ~ '^\d{14}$'::text))`, alone or
 * ANDed with other conditions - each AND part must hold, so its pattern
 * does. A CHECK with an OR, a NOT (but IS NOT NULL) or a CASE is skipped: there the pattern
 * alone isn't required. A pattern matches anywhere in the value, as `~`
 * does; `~*` ignores case.
 */
export function checkConstraintPatterns(column: string, constraints: readonly { expression: string; message: string | null }[]): ColumnPattern[] {
  const out: ColumnPattern[] = [];
  for (const { expression, message } of constraints) {
    if (/\b(?:OR|NOT|CASE)\b/.test(expression.replace(/'(?:[^']|'')*'/g, "''").replace(/\bIS NOT NULL\b/g, ""))) continue;
    for (const match of expression.matchAll(MATCH)) {
      const name = match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2];
      if (name !== column) continue;
      const source = translatePattern(match[4]!.replace(/''/g, "'"));
      // PostgreSQL's `.` and `[^x]` match a newline too: `s`.
      const flags = match[3] === "~*" ? "is" : "s";
      if (source !== null && compiles(source, flags)) out.push({ source, flags, message });
    }
  }
  return out;
}

/** A bracket's POSIX classes that mean the same in JavaScript - not `alpha` and the like: PostgreSQL's follow the locale, so `á` is a letter there. */
const POSIX_CLASSES: Record<string, string> = { digit: "0-9", space: String.raw`\s`, xdigit: "0-9A-Fa-f" };
/** Escapes with one meaning in both - not `\w` (locale letters in PostgreSQL), `\b` (a backspace there), `\m`, `\y`, `\A`, `\Z`... */
const SHARED_ESCAPES = "dDsStn";

/** A PostgreSQL ARE pattern in JavaScript syntax, or null when any part of it might mean something else there. */
function translatePattern(pattern: string): string | null {
  if (pattern.startsWith("***")) return null;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      const escape = sharedEscape(pattern[i + 1], true);
      if (escape === null) return null;
      out += escape;
      i++;
    } else if (char === "(" && pattern[i + 1] === "?") {
      // Non-capturing groups and lookaheads read the same; embedded options don't exist in JavaScript.
      const kind = pattern[i + 2];
      if (kind !== ":" && kind !== "=" && kind !== "!") return null;
      out += `(?${kind}`;
      i += 2;
    } else if (char === "[") {
      const bracket = translateBracket(pattern, i);
      if (!bracket) return null;
      out += bracket.text;
      i = bracket.end;
    } else {
      out += char;
    }
  }
  return out;
}

/** `[...]` from `start`: its text in JavaScript and the index of its closing `]`. */
function translateBracket(pattern: string, start: number): { text: string; end: number } | null {
  let i = start + 1;
  let out = "[";
  if (pattern[i] === "^") {
    out += "^";
    i++;
  }
  // A leading `]` is a literal in PostgreSQL, an empty set in JavaScript.
  if (pattern[i] === "]") return null;
  for (; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "]") return { text: `${out}]`, end: i };
    if (char === "[") {
      const next = pattern[i + 1];
      if (next === ":") {
        const close = pattern.indexOf(":]", i + 2);
        const translated = close === -1 ? undefined : POSIX_CLASSES[pattern.slice(i + 2, close)];
        if (translated === undefined) return null;
        out += translated;
        i = close + 1;
      } else if (next === "." || next === "=") {
        return null;
      } else {
        out += "\\[";
      }
    } else if (char === "\\") {
      const escape = sharedEscape(pattern[i + 1], false);
      if (escape === null) return null;
      out += escape;
      i++;
    } else {
      out += char;
    }
  }
  return null;
}

/** `\` + `next`, when it means the same in both: a shared class, a backreference, or an escaped symbol. */
function sharedEscape(next: string | undefined, backreference: boolean): string | null {
  if (next === undefined) return null;
  if (SHARED_ESCAPES.includes(next)) return `\\${next}`;
  if (backreference && /[1-9]/.test(next)) return `\\${next}`;
  if (/[A-Za-z0-9]/.test(next)) return null;
  return `\\${next}`;
}

function compiles(source: string, flags: string): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}
