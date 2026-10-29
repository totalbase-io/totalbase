import { describe, expect, it } from 'vitest'
import { decimalSeparator, normalizeDecimalInput, numberFieldAccepts, numberFieldText, numberFieldValue } from './number-input'

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

// A number column's text input (DataViews.md §16.1): shown with the locale's decimal point, written as PostgreSQL reads it.
describe('number field', () => {
  it('shows what PostgreSQL sent with the locale\'s decimal point', () => {
    expect(numberFieldText('8403.13', 'es-AR')).toBe('8403,13')
    expect(numberFieldText('8403.13', 'en-US')).toBe('8403.13')
    expect(numberFieldText('30999259096', 'es-AR')).toBe('30999259096')
    expect(numberFieldText(null, 'es-AR')).toBe('')
  })

  it('writes digits, a leading minus and one separator - a comma or a point - as PostgreSQL reads it', () => {
    expect(numberFieldValue('8403,13', true)).toBe('8403.13')
    expect(numberFieldValue('8403.13', true)).toBe('8403.13')
    expect(numberFieldValue('-12,5', true)).toBe('-12.5')
    expect(numberFieldValue('1,2,3', true)).toBe('1.23')
    expect(numberFieldValue('12a3', true)).toBe('123')
    expect(numberFieldValue('9223372036854775807', false)).toBe('9223372036854775807')
    expect(numberFieldValue('12,5', false)).toBe('125')
    expect(numberFieldValue('5-', false)).toBe('5')
    expect(numberFieldValue('', true)).toBeNull()
  })

  it('refuses letters as they are typed', () => {
    expect(numberFieldAccepts('12', false)).toBe(true)
    expect(numberFieldAccepts(',', true)).toBe(true)
    expect(numberFieldAccepts(',', false)).toBe(false)
    expect(numberFieldAccepts('e', true)).toBe(false)
  })
})
