/** The decimal separator `locale` writes ("," in es-AR, "." in en-US). */
export function decimalSeparator(locale?: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find(part => part.type === 'decimal')?.value ?? '.'
}

/**
 * A number as typed, read the way a keypad user means it: where the locale
 * writes decimals with a comma (es-AR: 1.123,45), a text with no comma and
 * a single "." takes that "." as the decimal point - "1123.45" is 1123.45,
 * not 112345. A text with the locale's separator, or with several "."
 * (1.123.456), is left to the locale. Only how the typed text is read:
 * the number stored is the same.
 */
export function normalizeDecimalInput(text: string, locale?: string): string {
  const separator = decimalSeparator(locale)
  if (separator === '.' || text.includes(separator)) return text
  const dots = text.split('.').length - 1
  return dots === 1 ? text.replace('.', separator) : text
}

/**
 * Applies `normalizeDecimalInput` to a number input's text just before the
 * field reads it (leaving it, or Enter) - typing itself is left alone, the
 * "." stays on screen until then.
 */
export function commitDecimalInput(event: Event, locale?: string): void {
  if (!(event.target instanceof HTMLInputElement)) return
  if (event instanceof KeyboardEvent && event.key !== 'Enter') return
  const normalized = normalizeDecimalInput(event.target.value, locale)
  if (normalized !== event.target.value) event.target.value = normalized
}

/**
 * A number column's value as its text input shows it (DataViews.md §16.1, the number field): what PostgreSQL sent
 * ("8403.13", exact - a bigint and a numeric come as text), its decimal point the locale's ("8403,13"); none, empty.
 */
export function numberFieldText(value: unknown, locale?: string): string {
  if (value === null || value === undefined || value === '') return ''
  return String(value).replace('.', decimalSeparator(locale))
}

/**
 * What a number column's text input writes, from what was typed: digits, a leading minus and - with decimals - one
 * separator, a "," or a "." alike (no thousands separator is typed), sent with a "." as PostgreSQL reads it
 * ("8403,13" -> "8403.13"). Anything else typed is dropped; empty is null. Never a JavaScript number: a bigint or a
 * numeric keeps every digit, and PostgreSQL decides what it is.
 */
export function numberFieldValue(text: string, decimals: boolean): string | null {
  let out = ''
  let separator = false
  for (const char of text.trim()) {
    if (char >= '0' && char <= '9') out += char
    else if (char === '-' && out === '') out = '-'
    else if ((char === ',' || char === '.') && decimals && !separator) {
      separator = true
      out += '.'
    }
  }
  return out === '' ? null : out
}

/** Whether typed text may go into a number column's text input - a `beforeinput` refuses the rest (letters). */
export function numberFieldAccepts(data: string, decimals: boolean): boolean {
  return (decimals ? /^[\d.,-]*$/ : /^[\d-]*$/).test(data)
}
