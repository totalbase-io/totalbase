import { describe, expect, it } from 'vitest'
import { formatPgRange, inclusiveUpper, parsePgRange, rangeElement, rangeTimestampIso } from '~/utils/pg-range'

describe('a PostgreSQL range\'s text (T2)', () => {
  it('reads its bounds - quoted, bare, unbounded, empty', () => {
    expect(parsePgRange('[2026-01-01,2026-02-01)')).toEqual({ empty: false, lower: '2026-01-01', upper: '2026-02-01', lowerInclusive: true, upperInclusive: false })
    expect(parsePgRange('["2026-01-01 08:00:00-03","2026-01-01 12:00:00-03")')).toMatchObject({ lower: '2026-01-01 08:00:00-03', upper: '2026-01-01 12:00:00-03' })
    expect(parsePgRange('(,10]')).toMatchObject({ lower: null, upper: '10', lowerInclusive: false, upperInclusive: true })
    expect(parsePgRange('empty')).toMatchObject({ empty: true })
    expect(parsePgRange('nope')).toBeNull()
  })

  it('writes one - both sides empty is null', () => {
    expect(formatPgRange({ lower: '1', upper: '10', lowerInclusive: true, upperInclusive: true })).toBe('["1","10"]')
    expect(formatPgRange({ lower: '2026-01-01', upper: null, lowerInclusive: true, upperInclusive: false })).toBe('["2026-01-01",)')
    expect(formatPgRange({ lower: null, upper: '', lowerInclusive: true, upperInclusive: false })).toBeNull()
  })

  it('knows its bounds\' kind, a discrete range\'s last value and a timestamp as ISO', () => {
    expect(rangeElement('daterange')).toMatchObject({ kind: 'date', discrete: true })
    expect(rangeElement('tstzrange')).toMatchObject({ kind: 'timestamp', columnType: 'timestamp with time zone', discrete: false })
    expect(rangeElement('int4range')).toMatchObject({ kind: 'number', integer: true, discrete: true })
    expect(rangeElement('numrange')).toMatchObject({ kind: 'number', discrete: false })
    expect(inclusiveUpper('2026-03-01', 'date')).toBe('2026-02-28')
    expect(inclusiveUpper('10', 'number')).toBe('9')
    expect(rangeTimestampIso('2026-01-01 08:00:00-03')).toBe('2026-01-01T08:00:00-03:00')
  })
})

describe('a range\'s From past its To (M28)', () => {
  it('is said in the field', async () => {
    const { rangeErrors } = await import('~/utils/widget-form')
    const fields = [{ name: 'cupo', dataType: 'int4range' }, { name: 'turno', dataType: 'tstzrange' }]
    expect(rangeErrors(fields, { cupo: '["10","1"]', turno: '["2026-01-02T00:00:00Z","2026-01-01T00:00:00Z")' })).toEqual([
      { field: 'cupo', message: 'From is after To' },
      { field: 'turno', message: 'From is after To' }
    ])
    expect(rangeErrors(fields, { cupo: '["1","10"]', turno: '["2026-01-01",)' })).toEqual([])
  })
})
