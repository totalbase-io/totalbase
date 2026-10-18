/**
 * Where a PostgreSQL error points in the SQL Console's editor
 * (Specification_Administration.md §5.6). PostgreSQL reports `position` as
 * a 1-based *character* offset into the statement text it received; the
 * editor counts UTF-16 code units, lines and columns. `start` is the
 * editor offset (UTF-16) where the text sent to the server begins - not 0
 * when only the selection ran, or when leading whitespace was trimmed.
 *
 * Returns 1-based `line`/`column` (Monaco's own convention) and the
 * UTF-16 `offset` in `text`, or `null` when the position lies past the
 * end of the text.
 */
export function sqlErrorLocation(text: string, position: number, start = 0): { offset: number, line: number, column: number } | null {
  if (!Number.isInteger(position) || position < 1 || start < 0 || start > text.length) return null
  let offset = start
  // Step over position - 1 characters (code points - an emoji is one
  // character to PostgreSQL but two UTF-16 units here).
  for (let i = 1; i < position; i++) {
    if (offset >= text.length) return null
    offset += text.codePointAt(offset)! > 0xFFFF ? 2 : 1
  }
  if (offset >= text.length) return null
  const before = text.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return { offset, line: before.split('\n').length, column: offset - lineStart + 1 }
}
