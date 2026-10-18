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
