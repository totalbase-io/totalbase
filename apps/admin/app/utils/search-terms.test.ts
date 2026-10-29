import { describe, expect, it } from 'vitest'
import { regionalDatePattern, searchForApi } from './search-terms'

describe('searchForApi', () => {
  it('sends a day typed in the viewer\'s format as ISO, every other word as typed', () => {
    expect(searchForApi('perez 13/10/2026', 'dd/MM/yyyy')).toBe('perez 2026-10-13')
    expect(searchForApi('10/13/2026', 'MM/dd/yyyy')).toBe('2026-10-13')
  })

  it('leaves what is not exactly that pattern alone - a part, an impossible day, another format', () => {
    expect(searchForApi('10/2026', 'dd/MM/yyyy')).toBe('10/2026')
    expect(searchForApi('1/2/2026', 'dd/MM/yyyy')).toBe('1/2/2026')
    expect(searchForApi('31/02/2026', 'dd/MM/yyyy')).toBe('31/02/2026')
    expect(searchForApi('2026-10-13', 'dd/MM/yyyy')).toBe('2026-10-13')
  })

  it('without a date format (the browser\'s) sends the search as typed', () => {
    expect(searchForApi('13/10/2026', undefined)).toBe('13/10/2026')
    expect(searchForApi('13/10/2026', '')).toBe('13/10/2026')
  })
})

describe('regionalDatePattern', () => {
  it('writes the regional format\'s short date as a date-fns pattern', () => {
    expect(regionalDatePattern('es-AR')).toBe('dd\'/\'MM\'/\'yyyy')
    expect(searchForApi('13/10/2026', regionalDatePattern('es-AR'))).toBe('2026-10-13')
    expect(searchForApi('10/13/2026', regionalDatePattern('en-US'))).toBe('2026-10-13')
    expect(searchForApi('2026/10/13', regionalDatePattern('ja-JP'))).toBe('2026-10-13')
    expect(searchForApi('13.10.2026', regionalDatePattern('de-DE'))).toBe('2026-10-13')
  })
})
