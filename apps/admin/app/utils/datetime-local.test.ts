import { describe, expect, it } from 'vitest'
import { fromDateTimeLocal, pickerHourCycle, toDateTimeLocal } from './datetime-local'

describe('datetime-local', () => {
  it('shows a timestamptz in the viewer\'s time zone and writes it back as the same instant', () => {
    expect(toDateTimeLocal('2026-09-30T20:51:59.151Z', true, 'America/Argentina/Buenos_Aires')).toBe('2026-09-30T17:51:59')
    expect(fromDateTimeLocal('2026-09-30T17:51:59', true, 'America/Argentina/Buenos_Aires')).toBe('2026-09-30T20:51:59.000Z')
    expect(fromDateTimeLocal('2026-09-30T17:51', true, 'UTC')).toBe('2026-09-30T17:51:00.000Z')
  })

  it('passes a plain timestamp through - it has no zone', () => {
    expect(toDateTimeLocal('2026-09-30T20:51:59.123', false)).toBe('2026-09-30T20:51:59')
    expect(fromDateTimeLocal('2026-09-30T20:51', false)).toBe('2026-09-30T20:51')
  })

  it('reads nothing as empty and empty as null', () => {
    expect(toDateTimeLocal(null, true)).toBe('')
    expect(toDateTimeLocal('not a date', true)).toBe('')
    expect(fromDateTimeLocal('', true)).toBeNull()
  })
  it('picks a 12-hour picker only where the afternoon reads PM', () => {
    expect(pickerHourCycle('en-US')).toBe(12)
    expect(pickerHourCycle('es-AR')).toBe(24)
    expect(pickerHourCycle('es-ES')).toBe(24)
    expect(pickerHourCycle('de-DE')).toBe(24)
  })
})
