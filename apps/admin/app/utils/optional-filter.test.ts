import { describe, expect, it } from 'vitest'
import { optionalFilterSql } from './optional-filter'

describe('optionalFilterSql', () => {
  it('writes the standard pattern for each variable type', () => {
    expect(optionalFilterSql({ name: 'status', type: 'SELECT' }, 'status')).toBe('($VAR.status IS NULL OR status = $VAR.status)')
    expect(optionalFilterSql({ name: 'tags', type: 'SELECT', multiple: true }, 'tag')).toBe('($VAR.tags IS NULL OR tag = ANY($VAR.tags))')
    expect(optionalFilterSql({ name: 'period', type: 'DATE_RANGE' }, 'created_at'))
      .toBe('($VAR.period.from IS NULL OR created_at >= $VAR.period.from) AND ($VAR.period.to IS NULL OR created_at < $VAR.period.to)')
    expect(optionalFilterSql({ name: 'q', type: 'TEXT' }, ' name ')).toBe('($VAR.q IS NULL OR name ILIKE \'%\' || $VAR.q || \'%\')')
    expect(optionalFilterSql({ name: 'min', type: 'NUMBER' }, 'o.total')).toBe('($VAR.min IS NULL OR o.total = $VAR.min)')
  })
})
