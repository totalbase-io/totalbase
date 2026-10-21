import { TotalBaseError } from "@totalbase/errors";

/**
 * `$USER.<column>` / `$VAR.<name>[.from|.to]` references in dashboard
 * widget SQL (Dashboards.md §3).
 * They are never interpolated: bindSqlVariables() swaps each one for a
 * cast positional parameter and returns the values separately.
 */
export type SqlVariableRef =
  | { kind: "USER"; field: string }
  | { kind: "VAR"; name: string; part: DateRangePart | null };

/** A date range's bound - its own, or the previous period's (D22). */
export type DateRangePart = "from" | "to" | "prev_from" | "prev_to";

type Segment = { text: string } | { ref: SqlVariableRef };

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_QUOTE_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const REFERENCE = /^\$(USER|VAR)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.(prev_from|prev_to|from|to)\b)?/;

function invalid(message: string): never {
  throw new TotalBaseError("DASHBOARD_QUERY_INVALID", message);
}

/**
 * Splits SQL into plain text and variable references, the way
 * PostgreSQL's own lexer sees `$`: string literals (incl. E'' escapes),
 * quoted identifiers, `--`/`/* *\/` comments (nestable) and
 * `$tag$...$tag$` bodies are copied through untouched, so a `$USER.id`
 * written inside a string stays text. A `$` right after an identifier
 * character is part of that identifier (`col$1`), as in PostgreSQL.
 */
export function scanSqlVariables(sql: string): Segment[] {
  const segments: Segment[] = [];
  let text = "";
  let i = 0;

  function copyUntil(end: number): void {
    text += sql.slice(i, end);
    i = end;
  }

  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === "'") {
      const prev = sql[i - 1];
      const escapeString = (prev === "E" || prev === "e") && !IDENT_CHAR.test(sql[i - 2] ?? " ");
      let j = i + 1;
      while (j < sql.length) {
        if (escapeString && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      if (j >= sql.length) invalid("Unterminated string literal.");
      copyUntil(j + 1);
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      if (j >= sql.length) invalid("Unterminated quoted identifier.");
      copyUntil(j + 1);
      continue;
    }

    if (c === "-" && next === "-") {
      const newline = sql.indexOf("\n", i);
      copyUntil(newline === -1 ? sql.length : newline);
      continue;
    }

    if (c === "/" && next === "*") {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; continue; }
        if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; if (depth === 0) break; continue; }
        j++;
      }
      if (depth !== 0) invalid("Unterminated block comment.");
      copyUntil(j);
      continue;
    }

    if (c === "$" && !IDENT_CHAR.test(sql[i - 1] ?? " ")) {
      const rest = sql.slice(i);
      if (/^\$\d/.test(rest)) {
        invalid("Positional parameters ($1, $2...) aren't allowed in widget SQL - use $VAR.* or $USER.* instead.");
      }
      const reference = REFERENCE.exec(rest);
      if (reference) {
        if (text) segments.push({ text });
        text = "";
        segments.push({
          ref: reference[1] === "USER"
            ? { kind: "USER", field: reference[2]! }
            : { kind: "VAR", name: reference[2]!, part: (reference[3] as DateRangePart | undefined) ?? null },
        });
        // `$USER.x.from` isn't a thing - only the USER field itself is consumed.
        i += reference[1] === "USER" ? `$USER.${reference[2]}`.length : reference[0].length;
        continue;
      }
      const tag = DOLLAR_QUOTE_TAG.exec(rest);
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close === -1) invalid("Unterminated dollar-quoted string.");
        copyUntil(close + tag[0].length);
        continue;
      }
    }

    text += c;
    i++;
  }

  if (text) segments.push({ text });
  return segments;
}

export function referenceKey(ref: SqlVariableRef): string {
  return ref.kind === "USER" ? `USER.${ref.field}` : `VAR.${ref.name}${ref.part ? `.${ref.part}` : ""}`;
}

export function listSqlVariableRefs(sql: string): SqlVariableRef[] {
  const seen = new Map<string, SqlVariableRef>();
  for (const segment of scanSqlVariables(sql)) {
    if ("ref" in segment) seen.set(referenceKey(segment.ref), segment.ref);
  }
  return [...seen.values()];
}

/** Names of the `$VAR.*` variables a query uses - lets a host re-run only the widgets a changed value affects. */
export function referencedVariableNames(sql: string | null): string[] {
  if (!sql) return [];
  try {
    return [...new Set(listSqlVariableRefs(sql).filter((r) => r.kind === "VAR").map((r) => (r as { name: string }).name))];
  } catch {
    return [];
  }
}

export interface BoundVariable {
  value: unknown;
  /** A PostgreSQL type name from trusted metadata (format_type() or a fixed list) - never caller input. */
  cast: string;
}

/**
 * Replaces every reference with `($n::cast)` (the same reference reusing the
 * same `$n`) and returns the values in parameter order.
 */
export async function bindSqlVariables(
  sql: string,
  resolve: (ref: SqlVariableRef) => Promise<BoundVariable>,
): Promise<{ sql: string; params: unknown[] }> {
  const params: unknown[] = [];
  const indexByKey = new Map<string, string>();
  let out = "";
  for (const segment of scanSqlVariables(sql)) {
    if ("text" in segment) {
      out += segment.text;
      continue;
    }
    const key = referenceKey(segment.ref);
    let placeholder = indexByKey.get(key);
    if (!placeholder) {
      const bound = await resolve(segment.ref);
      params.push(bound.value);
      // Parenthesized so the cast binds to the parameter alone, whatever operator surrounds it.
      placeholder = `($${params.length}::${bound.cast})`;
      indexByKey.set(key, placeholder);
    }
    out += placeholder;
  }
  return { sql: out, params };
}
