/**
 * The one place an SQL identifier is quoted (AGENTS.md section 7: dynamic
 * identifiers are resolved from trusted catalog metadata, then quoted
 * centrally). Doubling embedded quotes makes any name a single identifier.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
