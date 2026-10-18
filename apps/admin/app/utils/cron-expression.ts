// The cron grammar on the client (Specification_Workflows.md §6.4.2,
// packages/workflows cron.ts): five fields, each `*`, a number or name,
// lists, ranges and steps; months JAN-DEC, weekdays SUN-SAT (0 and 7 both
// Sunday), case-insensitive. Validation only - the server's preview stays
// the authority on what an expression means.
export const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
export const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

interface FieldRange { min: number, max: number, names?: string[], namesFrom?: number }
const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES, namesFrom: 1 },
  { min: 0, max: 7, names: WEEKDAY_NAMES, namesFrom: 0 }
]

export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field, i) => isValidCronField(field, FIELD_RANGES[i]!))
}

function tokenValue(token: string, range: FieldRange): number | undefined {
  const named = range.names?.indexOf(token.toUpperCase()) ?? -1
  if (named >= 0) return named + range.namesFrom!
  return /^\d+$/.test(token) ? Number(token) : undefined
}

function isValidCronField(field: string, range: FieldRange): boolean {
  return field.split(',').every((part) => {
    const [rangePart, step, ...rest] = part.split('/')
    if (rest.length > 0 || !rangePart) return false
    if (step !== undefined && !(/^\d+$/.test(step) && Number(step) > 0)) return false
    if (rangePart === '*') return true
    const bounds = rangePart.split('-')
    if (bounds.length > 2) return false
    const values = bounds.map(token => tokenValue(token, range))
    if (values.some(v => v === undefined || v < range.min || v > range.max)) return false
    return values[0]! <= (values[1] ?? values[0]!)
  })
}

/**
 * A list of values as cron names, consecutive runs of three or more as a
 * range: [1,2,3,4,5] -> "MON-FRI", [1,3] -> "MON,WED".
 */
export function cronNameList(values: number[], names: string[], first: number): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    const name = (v: number) => names[v - first]!
    if (j - i >= 2) parts.push(`${name(sorted[i]!)}-${name(sorted[j]!)}`)
    else for (let k = i; k <= j; k++) parts.push(name(sorted[k]!))
    i = j + 1
  }
  return parts.join(',')
}
