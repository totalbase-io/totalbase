/**
 * The one place an SQL identifier or string literal is quoted (AGENTS.md §7: dynamic identifiers come from trusted
 * catalog metadata, then are quoted centrally; values are bind parameters). Plain functions, no `pg` - the query
 * engine, the schema service and TotalBase's own catalog (`@totalbase/tb-catalog`) all quote the same way;
 * `@totalbase/database` re-exports them.
 */

/** A name as one SQL identifier: double-quoted, embedded quotes doubled - an upper-case name or a reserved word means itself. */
export function quoteIdentifier(name: string): string {
  // PostgreSQL ends a statement's text at a NUL byte: inside an open quoted identifier it would cut the statement.
  if (name.includes("\u0000")) throw new Error("An SQL identifier never holds a NUL character.");
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A text as a standard SQL string constant: single-quoted, embedded quotes doubled (`standard_conforming_strings`
 * is on - PostgreSQL's default since 9.1 - so a backslash is plain text). Only where the grammar takes a constant and
 * no bind parameter: COMMENT ON, a CHECK or DEFAULT expression, replication options, a migration ledger row.
 */
export function quoteLiteral(text: string): string {
  if (text.includes("\u0000")) throw new Error("An SQL string constant never holds a NUL character.");
  return `'${text.replace(/'/g, "''")}'`;
}
