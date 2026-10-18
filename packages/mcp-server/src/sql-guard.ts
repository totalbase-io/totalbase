/**
 * execute_sql's second signal before destroying data (Specification_Administration.md
 * §11.6): which statements of a script drop, truncate, delete or revoke. A
 * call-shape guard, not security - the SQL Console's own gates are that - so
 * it only has to tell a statement from the text around it: a function body
 * ($$ ... $$), a comment, a string literal or a quoted identifier is never a
 * statement, and a trigger's `BEFORE INSERT OR DELETE` isn't a DELETE.
 */

/** The script with dollar-quoted bodies, comments, literals and quoted identifiers blanked out - statements and keywords only. */
export function sqlStatementText(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
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
      // A doubled quote is an escaped one, inside the same literal.
      let j = i + 1;
      while (j < sql.length && !(sql[j] === quote && sql[j + 1] !== quote)) j += sql[j] === quote ? 2 : 1;
      i = j + 1;
      out += " ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** A statement that starts by destroying - or a data-modifying WITH, or an ALTER that drops a column or constraint. */
const DESTRUCTIVE_STATEMENT = /^\s*(?:WITH\b[\s\S]*?\b)?(DROP|TRUNCATE|DELETE\s+FROM|REVOKE)\b|^\s*(ALTER)\b[\s\S]*?\bDROP\b(?!\s+(?:NOT\s+NULL|DEFAULT|IDENTITY|EXPRESSION)\b)/i;

/** The destructive statements' leading keywords, in order - empty for a script that destroys nothing. */
export function destructiveStatements(sql: string): string[] {
  return sqlStatementText(sql)
    .split(";")
    .flatMap((statement) => {
      const match = DESTRUCTIVE_STATEMENT.exec(statement);
      if (!match) return [];
      return [match[1] ? match[1].toUpperCase().replace(/\s+/g, " ") : "ALTER ... DROP"];
    });
}
