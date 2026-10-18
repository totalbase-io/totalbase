/**
 * A PostgreSQL range's text, as the Data API reads and writes it (T2): `[2026-01-01,2026-02-01)`,
 * `["2026-01-01 08:00:00-03","2026-01-01 12:00:00-03")`, `(,10]`, `empty`. Its bounds and whether each one
 * is in it; an empty side is unbounded. PostgreSQL decides what a range holds - a discrete one (int4range,
 * int8range, daterange) it rewrites to `[)` - this only reads and writes the text.
 */

export interface PgRange {
  empty: boolean
  lower: string | null
  upper: string | null
  lowerInclusive: boolean
  upperInclusive: boolean
}

/** One bound's text: quoted (`"a b"`, `\"` and `\\` escaped) or bare; nothing is unbounded. */
function readBound(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\(.)/g, '$1').replace(/""/g, '"')
  return trimmed
}

/** Splits a range's inside at its top-level comma - a quoted bound may hold one. */
function splitBounds(inside: string): [string, string] | null {
  let quoted = false
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '"') quoted = !quoted
    else if (c === ',' && !quoted) return [inside.slice(0, i), inside.slice(i + 1)]
  }
  return null
}

export function parsePgRange(text: unknown): PgRange | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.toLowerCase() === 'empty') return { empty: true, lower: null, upper: null, lowerInclusive: false, upperInclusive: false }
  const open = trimmed[0]
  const close = trimmed[trimmed.length - 1]
  if ((open !== '[' && open !== '(') || (close !== ']' && close !== ')')) return null
  const parts = splitBounds(trimmed.slice(1, -1))
  if (!parts) return null
  return { empty: false, lower: readBound(parts[0]), upper: readBound(parts[1]), lowerInclusive: open === '[', upperInclusive: close === ']' }
}

function writeBound(value: string | null): string {
  if (value === null || value === '') return ''
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** A range's text - both sides empty is no range (null). */
export function formatPgRange(range: Omit<PgRange, 'empty'>): string | null {
  if ((range.lower === null || range.lower === '') && (range.upper === null || range.upper === '')) return null
  return `${range.lowerInclusive ? '[' : '('}${writeBound(range.lower)},${writeBound(range.upper)}${range.upperInclusive ? ']' : ')'}`
}

/** What a range column's bounds are: dates, timestamps (with a zone or not), or numbers - and whether it's discrete. */
export function rangeElement(dataType: string | undefined): { kind: 'date' | 'timestamp' | 'number', columnType: string, discrete: boolean, integer: boolean } {
  const type = (dataType ?? '').toLowerCase()
  if (type.startsWith('daterange')) return { kind: 'date', columnType: 'date', discrete: true, integer: false }
  if (type.startsWith('tstzrange')) return { kind: 'timestamp', columnType: 'timestamp with time zone', discrete: false, integer: false }
  if (type.startsWith('tsrange')) return { kind: 'timestamp', columnType: 'timestamp without time zone', discrete: false, integer: false }
  if (type.startsWith('int4range') || type.startsWith('int8range')) return { kind: 'number', columnType: type.startsWith('int8') ? 'bigint' : 'integer', discrete: true, integer: true }
  return { kind: 'number', columnType: 'numeric', discrete: false, integer: false }
}

/** PostgreSQL's timestamp text inside a range (`2026-01-01 08:00:00-03`) as ISO (`2026-01-01T08:00:00-03:00`). */
export function rangeTimestampIso(text: string): string {
  return text.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
}

/** A discrete range's last value inside it: an exclusive upper bound one before (a day, a unit). */
export function inclusiveUpper(upper: string, kind: 'date' | 'number'): string {
  if (kind === 'number') return String(BigInt(upper) - 1n)
  const day = new Date(`${upper.slice(0, 10)}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  return day.toISOString().slice(0, 10)
}
