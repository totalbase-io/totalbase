/**
 * execute_sql's second signal before destroying data (Administration.md
 * §11.6): which statements of a script drop, truncate, delete or revoke. A
 * call-shape guard, not security - the SQL Console's own gates are that; a
 * function a SELECT calls runs SQL no guard can read - so
 * it only has to tell a statement from the text around it: a function body
 * ($$ ... $$), a comment, a string literal or a quoted identifier is never a
 * statement, and a trigger's `BEFORE INSERT OR DELETE` isn't a DELETE.
 */

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/** The script with dollar-quoted bodies, comments, literals and quoted identifiers blanked out - statements and keywords only. */
export function sqlStatementText(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    // A `$` inside an identifier (`a$b`) never opens a dollar quote; a tag is any identifier, non-ASCII letters too.
    const dollar = IDENTIFIER_CHAR.test(sql[i - 1] ?? "") ? null : /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      i = end === -1 ? sql.length : end + dollar[0].length;
      out += " ";
      continue;
    }
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      // A doubled quote is an escaped one, inside the same literal - and in an E'...' string, so is a backslashed one.
      const backslashes = quote === "'" && /[eE]/.test(sql[i - 1] ?? "") && !IDENTIFIER_CHAR.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length && !(sql[j] === quote && sql[j + 1] !== quote)) j += sql[j] === quote || (backslashes && sql[j] === "\\") ? 2 : 1;
      i = j + 1;
      out += " ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * A statement that starts by destroying - or a data-modifying WITH, an EXPLAIN ANALYZE (which runs its statement) or
 * a PREPARE of one, or an ALTER that drops a column or constraint.
 */
const DESTRUCTIVE_STATEMENT =
  /^\s*(?:WITH\b[\s\S]*?\b|EXPLAIN\b[\s\S]*?\bANALYZE\b[\s\S]*?\b|PREPARE\b[\s\S]*?\bAS\b[\s\S]*?\b)?(DROP|TRUNCATE|DELETE\s+FROM|REVOKE)\b|^\s*(ALTER)\b[\s\S]*?\bDROP\b(?!\s+(?:NOT\s+NULL|DEFAULT|IDENTITY|EXPRESSION)\b)/i;

/** What runs code or SQL this guard can't read (an anonymous block, a procedure, a prepared statement), or a MERGE that deletes. */
const OPAQUE_STATEMENT =
  /^\s*(?:EXPLAIN\b[\s\S]*?\bANALYZE\b[\s\S]*?\b)?(DO|CALL|EXECUTE)\b|^\s*(?:WITH\b[\s\S]*?\b)?(MERGE)\b[\s\S]*?\bDELETE\b|^\s*(COPY)\s*\([\s\S]*?\b(?:DELETE|UPDATE|INSERT|MERGE)\b|^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(RULE)\b/i;

/** The destructive statements' leading keywords, in order - empty for a script that destroys nothing. */
export function destructiveStatements(sql: string): string[] {
  return sqlStatementText(sql)
    .split(";")
    .flatMap((statement) => {
      const match = DESTRUCTIVE_STATEMENT.exec(statement);
      if (match) return [match[1] ? match[1].toUpperCase().replace(/\s+/g, " ") : "ALTER ... DROP"];
      const opaque = OPAQUE_STATEMENT.exec(statement);
      if (opaque) return [(opaque[1] ?? (opaque[2] ? `${opaque[2]} ... DELETE` : opaque[3] ? "COPY (...)" : "CREATE RULE")).toUpperCase()];
      return [];
    });
}
