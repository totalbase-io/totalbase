import { describe, expect, it } from 'vitest'
import { decimalSeparator, normalizeDecimalInput } from './number-input'

describe('decimalSeparator()', () => {
  it('is the locale\'s own', () => {
    expect(decimalSeparator('es-AR')).toBe(',')
    expect(decimalSeparator('de-DE')).toBe(',')
    expect(decimalSeparator('en-US')).toBe('.')
  })
})

describe('normalizeDecimalInput()', () => {
  it('reads a single "." as the decimal point where the locale writes a comma', () => {
    expect(normalizeDecimalInput('1123.45', 'es-AR')).toBe('1123,45')
    expect(normalizeDecimalInput('-0.5', 'es-AR')).toBe('-0,5')
  })

  it('leaves the locale\'s own text alone', () => {
    expect(normalizeDecimalInput('1.123,45', 'es-AR')).toBe('1.123,45')
    expect(normalizeDecimalInput('1123,45', 'es-AR')).toBe('1123,45')
    expect(normalizeDecimalInput('1.123.456', 'es-AR')).toBe('1.123.456')
    expect(normalizeDecimalInput('1123', 'es-AR')).toBe('1123')
  })

  it('changes nothing where "." is already the decimal point', () => {
    expect(normalizeDecimalInput('1,123.45', 'en-US')).toBe('1,123.45')
  })
})
